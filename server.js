import 'dotenv/config';
import express from 'express';
import { Cluster } from 'puppeteer-cluster';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini 설정
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

let cluster;

// [대규모 접속 최적화] 클러스터 초기화 함수
async function initCluster() {
    const isLinux = process.platform === 'linux';
    const userDataPath = path.join(__dirname, 'user_data');
    
    if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
    }

    cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_PAGE, // [핵심 변경] 하나의 브라우저 내에서 페이지(탭)만 공유하여 세션 유지 극대화
        maxConcurrency: 2, // VPS 사양에 맞춰 동시 작업 2개로 제한 (업그레이드 시 4로 조정 가능)
        puppeteerOptions: {
            headless: true,
            userDataDir: userDataPath, // 세션 데이터 저장 폴더
            args: isLinux ? [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process',
                '--disable-gpu', '--no-first-run'
            ] : ['--no-sandbox', '--disable-setuid-sandbox']
        },
        retryLimit: 1,
        timeout: 120000
    });

    // 검색 작업 정의
    await cluster.task(async ({ page, data }) => {
        const { insuranceCompany, productName, insuranceType, startTime } = data;
        
        const logTime = (msg) => {
            const diff = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[상태] ${msg} (+${diff}s)`);
        };

        // 리소스 차단 (이미지, 폰트)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // 1. 메인 페이지 접속 및 로그인 여부 확인
        logTime('페이지 접속 중...');
        await page.goto('https://incar.ohmymanager.com/index.html', { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });

        // 로그인 창이 있는지 확인
        const loginIdInput = await page.$('#id');
        if (loginIdInput) {
            logTime('로그인 필요 (신규 세션)');
            await page.evaluate(() => {
                document.getElementById('id').value = '2334814';
                document.getElementById('pw').value = '2334814';
                document.getElementById('btnLogin').click();
            });
            // 로그인 후 메뉴가 나타날 때까지 대기
            await page.waitForSelector('#menu0801', { timeout: 30000 });
        } else {
            logTime('이미 로그인 됨 (세션 유지 성공)');
            // 혹시 메인 화면이 아니면 메인으로 이동 (강제)
            const menuExists = await page.$('#menu0801');
            if (!menuExists) {
                await page.goto('https://incar.ohmymanager.com/index.html', { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('#menu0801', { timeout: 15000 });
            }
        }

        // 2. 검색 페이지(팝업) 열기
        logTime('메뉴 클릭 및 팝업 대기 중...');
        const [target] = await Promise.all([
            page.browser().waitForTarget(t => t.opener() === page.target(), { timeout: 60000 }),
            page.click('#menu0801')
        ]);

        const searchPage = await target.page();
        if (!searchPage) throw new Error("팝업 창을 열지 못했습니다.");
        
        await searchPage.setRequestInterception(true);
        searchPage.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await searchPage.waitForFunction(() => window.location.href.includes('token='), { timeout: 60000 });
        const urlObj = new URL(searchPage.url());
        const token = urlObj.searchParams.get('token');
        const origin = urlObj.origin;

        // 3. 상품 검색 수행
        await searchPage.waitForSelector('#cbo_company', { timeout: 30000 });
        logTime('검색 필터 설정 중...');
        
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
            await new Promise(r => setTimeout(r, 1000));
            document.getElementById('txt_product_name').value = pName;
            document.getElementById('btn_get_products').click();
        }, insuranceCompany, productName, insuranceType);

        // 4. 결과 리스트 대기 및 추출
        logTime('결과 데이터 로딩 중...');
        // 실제 데이터가 로딩될 때까지 지능형 대기
        await new Promise(r => setTimeout(r, 2000));
        await searchPage.waitForFunction(() => {
            const rows = document.querySelectorAll('#tbl_display_proucts .table-row');
            return rows.length > 0 || document.body.innerText.includes('조회한 상품이 없습니다');
        }, { timeout: 30000 });

        const results = await searchPage.evaluate(() => {
            const list = [];
            const rows = document.querySelectorAll('#tbl_display_proucts .table-row');
            rows.forEach(row => {
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
                if (title && !title.includes('조회한 상품이 없습니다')) {
                    list.push({ 
                        title, date, 
                        terms: getBtnInfo('.col-doc-1'), 
                        business: getBtnInfo('.col-doc-2'), 
                        summary: getBtnInfo('.col-doc-3') 
                    });
                }
            });
            return list;
        });

        logTime(`완료 (${results.length}건)`);
        await searchPage.close(); // 팝업 창만 닫음 (메인 탭은 재사용)
        
        return { success: true, results, token, origin };
    });

    console.log('🚀 클러스터 관리 엔진 기동 완료 (세션 공유 모드)');
}

initCluster().catch(err => console.error('클러스터 기동 실패:', err));

app.post('/api/ocr', async (req, res) => {
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ success: false, message: "이미지 데이터가 없습니다." });
        const base64Data = image.split(',')[1] || image;
        const result = await model.generateContent([
            "이미지에서 다음 정보를 추출하세요:\n1. 보험사명\n2. 상품명\n3. 계약일 (YYYY.MM.DD 형식)\n\n결과는 오직 '보험사,상품명,날짜' 형식으로만 출력하세요.",
            { inlineData: { data: base64Data, mimeType: "image/jpeg" } }
        ]);
        const text = result.response.text().trim();
        console.log('[Gemini OCR 결과]:', text);
        res.json({ success: true, text });
    } catch (error) {
        console.error('Gemini OCR 에러:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/search', async (req, res) => {
    const { insuranceCompany, productName, insuranceType } = req.body;
    const startTime = Date.now();
    try {
        const result = await cluster.execute({ insuranceCompany, productName, insuranceType, startTime });
        res.json(result);
    } catch (error) {
        console.error('검색 클러스터 에러:', error.message);
        res.status(500).json({ success: false, message: '현재 대기 인원이 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
});
// PDF 로직
app.get('/api/pdf', async (req, res) => {
    const { cc, fn, jm, dt, token, origin } = req.query;
    console.log(`\n[PDF 요청] 파일: ${fn}`);

    try {
        // Express가 이미 디코딩을 마친 상태이므로, 
        // 외부 API로 보낼 때만 다시 인코딩해줍니다.
        const safeFn = encodeURIComponent(fn);

        const pdfUrl = `${origin}/api/product-doc-url?company_cd=${cc}&filename=${safeFn}&job_month=${jm}&doctype=${dt}`;

        console.log(`[PDF 단계 1] 주소 요청: ${pdfUrl}`);

        const authRes = await fetch(pdfUrl, { 
            headers: { 
                'Authorization': token, 
                'Content-Type': 'application/json' 
            } 
        });
        const authData = await authRes.json();

        if (!authData.isSuccess) throw new Error(authData.errorMessage || "URL 추출 실패");

        const finalPdfUrl = authData.url.startsWith('http') ? authData.url : new URL(authData.url, origin).href;
        console.log(`[PDF 단계 2] 스트리밍 시작`);

        const response = await fetch(finalPdfUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });

        if (!response.ok) throw new Error(`바이너리 응답 에러: ${response.status}`);

        res.setHeader('Content-Type', 'application/pdf');
        
        // 한글 파일명 대응을 위한 RFC 5987 인코딩 방식 적용
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${safeFn}`);

        const reader = response.body;
        for await (const chunk of reader) { 
            res.write(chunk); 
        }
        res.end();
    } catch (e) {
        console.error('[PDF 에러]', e.message);
        res.status(500).send("PDF 에러: " + e.message);
    }
});

app.listen(PORT, () => console.log(`🚀 서버 구동 중: http://localhost:${PORT}`));
