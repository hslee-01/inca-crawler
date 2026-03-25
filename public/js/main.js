
        const imageInput = document.getElementById('imageInput');
        const insuranceInput = document.getElementById('insuranceCompany');
        const productInput = document.getElementById('productName');
        const typeInput = document.getElementById('insuranceType');
        const dateInput = document.getElementById('contractDate');
        const searchBtn = document.getElementById('searchBtn');
        const cancelBtn = document.getElementById('cancelBtn');
        const statusDiv = document.getElementById('status');
        const resultsDiv = document.getElementById('results');
        const canvas = document.getElementById('preprocessCanvas');

        let searchAbortController = null; // 검색 취소를 위한 컨트롤러

        const companyMap = [
            { keywords: ['ABL', '에이비엘'], name: 'ABL생명', type: 'L' },
            { keywords: ['삼성생명'], name: '삼성생명', type: 'L' },
            { keywords: ['한화생명'], name: '한화생명', type: 'L' },
            { keywords: ['교보'], name: '교보생명', type: 'L' },
            { keywords: ['신한', 'SHINHAN'], name: '신한라이프', type: 'L' },
            { keywords: ['동양', '수호천사', '우리WON'], name: '동양생명', type: 'L' },
            { keywords: ['흥국생명'], name: '흥국생명', type: 'L' },
            { keywords: ['라이나', 'LINA'], name: '라이나생명', type: 'L' },
            { keywords: ['AIA'], name: 'AIA생명', type: 'L' },
            { keywords: ['농협생명'], name: '농협생명', type: 'L' },
            { keywords: ['미래에셋'], name: '미래에셋생명', type: 'L' },
            { keywords: ['DB', '디비', '동부', '컨버전스'], name: 'DB손해보험', type: 'F' },
            { keywords: ['메리츠', 'MERITZ'], name: '메리츠화재', type: 'F' },
            { keywords: ['현대해상', 'HYUNDAI'], name: '현대해상화재', type: 'F' },
            { keywords: ['삼성화재'], name: '삼성화재', type: 'F' },
            { keywords: ['한화손해', '한화손보'], name: '한화손해보험', type: 'F' },
            { keywords: ['KB', '케비'], name: 'KB손해보험', type: 'F' },
            { keywords: ['흥국화재'], name: '흥국화재', type: 'F' },
            { keywords: ['롯데', 'LOTTE'], name: '롯데손해보험', type: 'F' },
            { keywords: ['MG', '엠지'], name: 'MG손해보험', type: 'F' },
            { keywords: ['농협손해'], name: '농협손해보험', type: 'F' },
            { keywords: ['하나손해'], name: '하나손해보험', type: 'F' },
            { keywords: ['AXA', '악사'], name: 'AXA손해보험', type: 'F' },
            { keywords: ['에이스', 'ACE'], name: '에이스손해', type: 'F' }
        ];

        imageInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            document.body.classList.add('loading');
            searchBtn.disabled = true;
            resultsDiv.innerHTML = '';
            
            let ocrSeconds = 0;
            statusDiv.innerHTML = `🧬 AI 분석 엔진 가동 중... (${ocrSeconds}s)`;
            const ocrTimer = setInterval(() => {
                ocrSeconds++;
                statusDiv.innerHTML = `🧬 AI 분석 엔진 가동 중... (${ocrSeconds}s)`;
            }, 1000);

            const img = new Image();
            img.src = URL.createObjectURL(file);
            img.onload = async () => {
                const cropCanvas = document.createElement('canvas');
                const cropCtx = cropCanvas.getContext('2d');
                const sourceWidth = img.naturalWidth;
                const sourceHeight = img.naturalHeight;
                const aspectRatio = sourceHeight / sourceWidth;

                // 세로가 가로보다 1.2배 이상 긴 경우(모바일 캡쳐 등)에만 상단 50% 크롭 적용
                let targetHeight = sourceHeight;
                if (aspectRatio > 1.2) {
                    targetHeight = sourceHeight * 0.50;
                }

                const maxWidth = 1024;
                const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
                
                cropCanvas.width = sourceWidth * scale;
                cropCanvas.height = targetHeight * scale;
                cropCtx.imageSmoothingQuality = 'high';
                cropCtx.drawImage(img, 0, 0, sourceWidth, targetHeight, 0, 0, cropCanvas.width, cropCanvas.height);
                
                const croppedDataUrl = cropCanvas.toDataURL('image/jpeg', 0.8); 
                document.getElementById('imagePreview').src = croppedDataUrl;
                document.getElementById('imagePreviewContainer').style.display = 'block';

                try {
                    const response = await fetch('/api/ocr', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image: croppedDataUrl })
                    });
                    
                    const result = await response.json();
                    if (!result.success) throw new Error(result.message);

                    const text = result.text;
                    const parts = text.split(',').map(s => s.trim());
                    const company = parts[0];
                    const productName = parts[1];
                    const contractDate = parts[2];

                    if (company && company !== '미상') {
                        let matched = companyMap.find(c => 
                            c.keywords.some(k => company.includes(k) || k.includes(company))
                        );
                        if (matched) {
                            insuranceInput.value = matched.name;
                            typeInput.value = matched.type;
                        } else {
                            insuranceInput.value = company;
                        }
                    }

                    if (productName && productName !== '미상') {
                        const cleanedProduct = productName
                            .split('_')[0]
                            .replace(/^(\(무\)|무\)|무배당|\(무배당\)|[A-Z]\)|E\)|F\))/, '')
                            .trim();
                        productInput.value = cleanedProduct;
                    }

                    if (contractDate && contractDate !== '미상') {
                        dateInput.value = contractDate.replace(/-/g, '.');
                    }

                    statusDiv.innerHTML = `✨ 분석 완료 (${ocrSeconds}초)`;
                } catch (err) {
                    statusDiv.innerHTML = '❌ 분석 오류가 발생했습니다.';
                } finally {
                    clearInterval(ocrTimer);
                    document.body.classList.remove('loading');
                    searchBtn.disabled = false;
                }
            };
        });

        // 취소 버튼 클릭 이벤트
        cancelBtn.addEventListener('click', () => {
            if (searchAbortController) {
                searchAbortController.abort(); // 요청 중단
                searchAbortController = null;
            }
        });

        searchBtn.addEventListener('click', async () => {
            const insuranceCompany = insuranceInput.value;
            const productName = productInput.value;
            const insuranceType = typeInput.value;

            if(!insuranceCompany || !productName) return alert('정보가 부족합니다.');

            // 상태 변경: 검색 중
            searchBtn.disabled = true;
            searchBtn.innerText = '검색 중...';
            cancelBtn.style.display = 'block';
            resultsDiv.innerHTML = '';
            
            let seconds = 0;
            statusDiv.innerHTML = `🔍 서버에서 약관을 찾는 중... (${seconds}s)`;
            const timer = setInterval(() => {
                seconds++;
                statusDiv.innerHTML = `🔍 서버에서 약관을 찾는 중... (${seconds}s)`;
            }, 1000);

            // AbortController 생성
            searchAbortController = new AbortController();

            try {
                const res = await fetch('/api/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ insuranceCompany, productName, insuranceType }),
                    signal: searchAbortController.signal // 시그널 전달
                });
                const data = await res.json();
                
                clearInterval(timer);

                if (data.success && data.results.length > 0) {
                    statusDiv.innerHTML = `🎯 <b>${data.results.length}건</b>의 약관을 매칭했습니다.`;
                    
                    const { token, origin } = data;
                    const baseDateVal = dateInput.value.trim().replace(/\./g, '-');
                    const baseDate = baseDateVal ? new Date(baseDateVal) : null;
                    
                    let targetIdx = -1;
                    if (baseDate && !isNaN(baseDate)) {
                        let minDiff = Infinity;
                        data.results.forEach((item, idx) => {
                            const salesDate = new Date(item.date.trim().replace(/\./g, '-'));
                            if (!isNaN(salesDate) && salesDate >= baseDate) {
                                const diff = salesDate.getTime() - baseDate.getTime();
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    targetIdx = idx;
                                }
                            }
                        });
                    }

                    resultsDiv.innerHTML = data.results.map((item, index) => {
                        const isRecommend = (index === targetIdx);
                        const recommendClass = isRecommend ? 'recommend' : '';
                        const badge = isRecommend ? '<div class="tag tag-blue">BEST MATCH</div>' : '';
                        
                        const makeUrl = (d) => {
                            if(!d) return '#';
                            const params = new URLSearchParams({
                                cc: d.cc, fn: d.fn, jm: d.jm, dt: d.dt, token: token, origin: origin
                            });
                            return `/api/pdf?${params.toString()}`;
                        };

                        return `
                            <div class="result-item ${recommendClass}">
                                ${badge}
                                <h3>${item.title}</h3>
                                <p>📅 판매일: ${item.date}</p>
                                <div class="docs">
                                    <a href="${makeUrl(item.terms)}" target="_blank" class="doc-link highlight">약관보기</a>
                                    <a href="${makeUrl(item.business)}" target="_blank" class="doc-link">방법서</a>
                                    <a href="${makeUrl(item.summary)}" target="_blank" class="doc-link">요약서</a>
                                </div>
                            </div>
                        `;
                    }).join('');
                    
                    setTimeout(() => {
                        window.scrollTo({ top: statusDiv.offsetTop - 20, behavior: 'smooth' });
                    }, 100);
                } else {
                    statusDiv.innerText = '검색 결과가 없습니다. 상품명을 확인해 주세요.';
                }
            } catch (e) {
                if (e.name === 'AbortError') {
                    statusDiv.innerText = '❌ 검색이 취소되었습니다.';
                } else {
                    statusDiv.innerText = '❌ 연결 오류가 발생했습니다.';
                }
                clearInterval(timer);
            } finally {
                searchBtn.disabled = false;
                searchBtn.innerText = '실시간 약관 조회';
                cancelBtn.style.display = 'none';
                searchAbortController = null;
            }
        });
    