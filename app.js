// public/js/app.js

let ocrStartTime;
let ocrTimerInterval;

/**
 * 이미지를 리사이징하고 Base64로 인코딩합니다.
 * @param {File} file - 원본 이미지 파일.
 * @param {number} maxWidth - 최대 가로 길이.
 * @param {number} cropRatio - 상단에서 크롭할 비율 (예: 0.4는 상단 40% 크롭).
 * @returns {Promise<string>} Base64 인코딩된 이미지 데이터.
 */
export function resizeAndCropImage(file, maxWidth, cropRatio) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                const originalWidth = img.width;
                const originalHeight = img.height;

                // 크롭할 높이 계산
                const cropHeight = originalHeight * cropRatio;

                // 리사이징 비율 계산
                let newWidth = originalWidth;
                let newHeight = originalHeight - cropHeight; // 크롭된 높이

                if (newWidth > maxWidth) {
                    newHeight = Math.floor((newHeight / newWidth) * maxWidth);
                    newWidth = maxWidth;
                }

                canvas.width = newWidth;
                canvas.height = newHeight;

                // 상단 cropHeight만큼 잘라내고 리사이징하여 그리기
                ctx.drawImage(img, 0, cropHeight, originalWidth, originalHeight - cropHeight, 0, 0, newWidth, newHeight);

                resolve(canvas.toDataURL('image/jpeg', 0.8)); // JPEG, 품질 0.8
            };
            img.onerror = reject;
            img.src = event.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * OCR 타이머를 시작합니다.
 * @param {HTMLElement} timerElement - 타이머 시간을 표시할 HTML 요소.
 */
export function startOcrTimer(timerElement) {
    ocrStartTime = Date.now();
    timerElement.textContent = '0';
    ocrTimerInterval = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - ocrStartTime) / 1000);
        timerElement.textContent = elapsedSeconds.toString();
    }, 1000);
}

/**
 * OCR 타이머를 중지합니다.
 */
export function stopOcrTimer() {
    if (ocrTimerInterval) {
        clearInterval(ocrTimerInterval);
        ocrTimerInterval = null;
    }
}

// 기타 UI 관련 함수들을 여기에 추가할 수 있습니다.