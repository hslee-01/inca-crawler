import 'dotenv/config';
import express from 'express';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// sleep 헬퍼 함수
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Gemini 설정
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// [디버그] 사용 가능한 모델 목록 확인 (404 에러 원인 파악용)
async function listModels() {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await response.json();
        console.log('--- [Gemini API 사용 가능 모델 목록] ---');
        data.models?.forEach(m => console.log(`- ${m.name}`));
        console.log('---------------------------------------');
    } catch (e) {
        console.error('모델 목록 확인 실패:', e.message);
    }
}
listModels();

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

let searchPage;

// Gemini OCR 엔드포인트
app.post('/api/ocr', async (req, res) => {
    try {
        const { image } = req.body; // base64 data
        if (!image) return res.status(400).json({ success: false, message: "이미지 데이터가 없습니다." });

        const base64Data = image.split(',')[1] || image;
        
        const result = await model.generateContent([
            "이미지에서 다음 정보를 추출하세요:\n" +
            "1. 보험사명 (예: 삼성화재, 라이나생명, 메리츠화재 등)\n" +
            "2. 상품명 (가장 크게 적힌 공식 이름)\n" +
            "3. 계약일 (YYYY.MM.DD 형식, 날짜가 여러 개라면 가장 앞의 시작 날짜를 선택)\n\n" +
            "결과는 오직 '보험사,상품명,날짜' 형식으로만 출력하세요. 못 찾으면 '미상'으로 하세요. 다른 설명은 하지 마세요.",
            {
                inlineData: {
                    data: base64Data,
                    mimeType: "image/jpeg"
                }
            }
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
    console.log(`\n[검색 시작] ${insuranceCompany} / ${productName}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();

        await page.goto('https://incar.ohmymanager.com/index.html', { waitUntil: 'networkidle2' });
        await page.evaluate(() => {
            document.getElementById('id').value = '2334814';
            document.getElementById('pw').value = '2334814';
            document.getElementById('btnLogin').click();
        });

        // 로그인 처리 대기 시간 증가 (4초 -> 6초)
        await new Promise(r => setTimeout(r, 6000));

        const pageTarget = page.target();
        await page.evaluate(() => document.getElementById('menu0801')?.click());

        // 검색 페이지 팝업 대기 타임아웃 증가 (15초 -> 30초)
        const newTarget = await browser.waitForTarget(target => 
            target.opener() === pageTarget && target.url().includes('token='),
            { timeout: 30000 }
        );
        searchPage = await newTarget.page();
        await new Promise(r => setTimeout(r, 2000));

        const urlObj = new URL(searchPage.url());
        const token = urlObj.searchParams.get('token');
        const origin = urlObj.origin;

        await searchPage.evaluate(async (company, pName, type) => {
            const typeSelect = document.getElementById('cbo_company_type');
            if (typeSelect) {
                typeSelect.value = type || 'F';
                typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await new Promise(r => setTimeout(r, 3000));

            const compSelect = document.getElementById('cbo_company');
            if (compSelect) {
                const targetOpt = Array.from(compSelect.options).find(o => o.text.includes(company));
                if (targetOpt) {
                    compSelect.value = targetOpt.value;
                    compSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            await new Promise(r => setTimeout(r, 2000));

            document.getElementById('txt_product_name').value = pName;
            document.getElementById('btn_get_products').click();
        }, insuranceCompany, productName, insuranceType);

        // 결과 리스트 로딩 대기 시간 증가 (4초 -> 6초)
        await new Promise(r => setTimeout(r, 6000));

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
                if (title && !title.includes('조회한 상품이 없습니다')) {
                    results.push({ title, date, terms: getBtnInfo('.col-doc-1'), business: getBtnInfo('.col-doc-2'), summary: getBtnInfo('.col-doc-3') });
                }
            });
            return results;
        });

        res.json({ success: true, results: allResults, token, origin });

    } catch (error) {
        console.error('에러 발생:', error.message);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        // [원복] 매 검색 종료 후 브라우저 종료하여 세션 오염 방지
        if (browser) await browser.close();
    }
});

// PDF 로직 (가장 완벽한 복구본 유지)
app.get('/api/pdf', async (req, res) => {
    const { cc, fn, jm, dt, token, origin } = req.query;
    console.log(`\n[PDF 요청] 파일: ${fn}`);

    try {
        const safeFn = encodeURIComponent(decodeURIComponent(fn));
        const pdfUrl = `${origin}/api/product-doc-url?company_cd=${cc}&filename=${safeFn}&job_month=${jm}&doctype=${dt}`;
        
        console.log(`[1단계: PDF 주소 요청] ${pdfUrl}`);

        const authRes = await fetch(pdfUrl, {
            headers: { 'Authorization': token, 'Content-Type': 'application/json' }
        });
        const authData = await authRes.json();

        if (!authData.isSuccess) throw new Error(authData.errorMessage || "URL 추출 실패");

        const finalPdfUrl = authData.url.startsWith('http') ? authData.url : new URL(authData.url, origin).href;
        console.log(`[2단계: 바이너리 스트리밍 시작] ${finalPdfUrl}`);

        const response = await fetch(finalPdfUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!response.ok) throw new Error(`바이너리 응답 에러: ${response.status}`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline');

        const reader = response.body;
        for await (const chunk of reader) {
            res.write(chunk);
        }
        res.end();
        console.log(`[PDF 전송 완료] ${fn}`);

    } catch (e) {
        console.error('[PDF 에러]', e.message);
        res.status(500).send("PDF 에러: " + e.message);
    }
});

app.listen(PORT, () => console.log(`🚀 서버 구동 중: http://localhost:${PORT}`));
