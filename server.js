import express from 'express';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

let globalBrowser;
let searchPage;
let currentToken = "";
let currentOrigin = "";

async function initBrowser() {
    if (!globalBrowser || !globalBrowser.connected) {
        globalBrowser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null, // Docker 환경 대응
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // 메모리 부족 방지
                '--window-size=1600,1000'
            ]
        });
    }
    return globalBrowser;
}

app.post('/api/search', async (req, res) => {
    const { insuranceCompany, productName, insuranceType } = req.body;
    console.log(`\n[검색] ${insuranceCompany} / ${productName}`);

    try {
        const browser = await initBrowser();
        const page = await browser.newPage();

        await page.goto('https://incar.ohmymanager.com/index.html', { waitUntil: 'networkidle2' });
        await page.evaluate(() => {
            document.getElementById('id').value = '2334814';
            document.getElementById('pw').value = '2334814';
            document.getElementById('btnLogin').click();
        });

        await new Promise(r => setTimeout(r, 4000));

        const pageTarget = page.target();
        await page.evaluate(() => document.getElementById('menu0801')?.click());

        const newTarget = await browser.waitForTarget(target => target.opener() === pageTarget);
        searchPage = await newTarget.page();
        
        const urlObj = new URL(searchPage.url());
        currentToken = urlObj.searchParams.get('token');
        currentOrigin = urlObj.origin;

        await searchPage.evaluate(async (company, pName, type) => {
            const typeSelect = document.getElementById('cbo_company_type');
            if (typeSelect) {
                typeSelect.value = type || 'F';
                typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await new Promise(r => setTimeout(r, 2000));

            const compSelect = document.getElementById('cbo_company');
            if (compSelect) {
                const targetOpt = Array.from(compSelect.options).find(o => o.text.includes(company));
                if (targetOpt) {
                    compSelect.value = targetOpt.value;
                    compSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            await new Promise(r => setTimeout(r, 1000));

            document.getElementById('txt_product_name').value = pName;
            document.getElementById('btn_get_products').click();
        }, insuranceCompany, productName, insuranceType);

        await new Promise(r => setTimeout(r, 4000));

        const allResults = await searchPage.evaluate(async () => {
            const results = [];
            const pageButtons = Array.from(document.querySelectorAll('#pagination .num'));
            const maxPage = pageButtons.length > 0 ? Math.max(...pageButtons.map(b => parseInt(b.innerText) || 1)) : 1;

            for (let p = 1; p <= maxPage; p++) {
                if (p > 1) {
                    state.change_page(p);
                    await new Promise(r => setTimeout(r, 2000));
                }

                const rows = Array.from(document.querySelectorAll('#tbl_display_proucts .table-row'));
                rows.forEach((row) => {
                    const title = row.querySelector('.col-product-name')?.innerText.trim();
                    const date = row.querySelector('.col-sales-date')?.innerText.trim();
                    
                    const getBtnInfo = (sel) => {
                        const b = row.querySelector(sel + ' button');
                        return b ? {
                            cc: b.getAttribute('data-company-cd'),
                            fn: b.getAttribute('data-filename'),
                            jm: b.getAttribute('data-job-month'),
                            dt: b.getAttribute('data-doctype')
                        } : null;
                    };

                    if (title) {
                        results.push({ 
                            title, date, 
                            terms: getBtnInfo('.col-doc-1'),
                            business: getBtnInfo('.col-doc-2'),
                            summary: getBtnInfo('.col-doc-3')
                        });
                    }
                });
            }
            return results;
        });

        await page.close();
        res.json({ success: true, results: allResults });

    } catch (error) {
        console.error('Search Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/pdf', async (req, res) => {
    const { cc, fn, jm, dt } = req.query;
    console.log(`\n[PDF 생성] 보험사: ${cc}, 파일: ${fn}`);

    try {
        if (!currentToken || !currentOrigin) throw new Error("세션 정보가 없습니다. 다시 검색해 주세요.");

        // [방법 1] 사이트 엔진을 직접 가동하여 '진짜 URL' 확보 시도
        let finalPdfUrl = "";
        if (searchPage && !searchPage.isClosed()) {
            finalPdfUrl = await searchPage.evaluate(async (cc, fn, jm, dt) => {
                return new Promise((resolve) => {
                    const originalOpen = window.open;
                    window.open = (url) => {
                        window.open = originalOpen;
                        resolve(url);
                        return { focus: () => {} };
                    };
                    try {
                        const fakeEvent = { preventDefault: () => {}, stopPropagation: () => {}, stopImmediatePropagation: () => {} };
                        product_doc_url(cc, fn, jm, dt, fakeEvent);
                    } catch (e) {
                        window.open = originalOpen;
                        resolve("");
                    }
                    setTimeout(() => { window.open = originalOpen; resolve(""); }, 3000);
                });
            }, cc, fn, jm, dt);
        }

        // [방법 2] 엔진 가동 실패 시, 보정된 파라미터명으로 직접 생성 (snake_case 적용)
        if (!finalPdfUrl) {
            console.log("...엔진 가동 실패, 수동 주소 생성 중...");
            finalPdfUrl = `${currentOrigin}/common/pdf_viewer.php?token=${currentToken}&company_cd=${cc}&filename=${encodeURIComponent(fn)}&job_month=${jm}&doctype=${dt}`;
        }

        console.log(`[최종 URL] ${finalPdfUrl.split('?')[0]}...`);

        const pdfRes = await fetch(finalPdfUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });

        if (!pdfRes.ok) throw new Error(`S3 서버 응답 에러: ${pdfRes.status} ${pdfRes.statusText}`);
        
        const buffer = Buffer.from(await pdfRes.arrayBuffer());
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="insurance.pdf"');
        res.send(buffer);

    } catch (e) {
        console.error('!!! PDF 에러:', e.message);
        res.status(500).send("문서를 열 수 없습니다: " + e.message);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 서버 시작: http://localhost:${PORT}`);
});
