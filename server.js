import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
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

// 버셀용 브라우저 초기화 로직
async function initBrowser() {
    if (!globalBrowser || !globalBrowser.connected) {
        const isLocal = !process.env.VERCEL; // 로컬 환경인지 버셀 환경인지 구분
        
        globalBrowser = await puppeteer.launch({
            args: isLocal ? ['--no-sandbox'] : chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: isLocal 
                ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' // 로컬 크롬 경로 (사용자 환경에 맞게 수정 필요할 수 있음)
                : await chromium.executablePath(),
            headless: chromium.headless,
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

        await new Promise(r => setTimeout(r, 3000));

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
            await new Promise(r => setTimeout(r, 1000));

            const compSelect = document.getElementById('cbo_company');
            if (compSelect) {
                const targetOpt = Array.from(compSelect.options).find(o => o.text.includes(company));
                if (targetOpt) {
                    compSelect.value = targetOpt.value;
                    compSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            document.getElementById('txt_product_name').value = pName;
            document.getElementById('btn_get_products').click();
        }, insuranceCompany, productName, insuranceType);

        // 버셀 10초 제한 때문에 대기 시간을 약간 줄입니다.
        await new Promise(r => setTimeout(r, 2500));

        const allResults = await searchPage.evaluate(async () => {
            const results = [];
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
                    results.push({ title, date, terms: getBtnInfo('.col-doc-1'), business: getBtnInfo('.col-doc-2'), summary: getBtnInfo('.col-doc-3') });
                }
            });
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
    try {
        if (!currentToken || !currentOrigin) throw new Error("세션 만료");
        const pdfUrl = `${currentOrigin}/common/pdf_viewer.php?token=${currentToken}&company_cd=${cc}&filename=${encodeURIComponent(fn)}&job_month=${jm}&doctype=${dt}`;
        const pdfRes = await fetch(pdfUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const buffer = Buffer.from(await pdfRes.arrayBuffer());
        res.setHeader('Content-Type', 'application/pdf');
        res.send(buffer);
    } catch (e) {
        res.status(500).send("PDF 에러: " + e.message);
    }
});

// 버셀 배포를 위해 익스프레스 앱 수출
export default app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
