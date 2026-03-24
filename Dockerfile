# 1. 최신 Node.js 이미지 사용
FROM node:20-slim

# 2. Puppeteer 실행에 필요한 브라우저 및 라이브러리 설치
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. 환경 변수 설정 (Puppeteer가 설치된 브라우저를 사용하도록 지시)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 4. 앱 디렉토리 생성
WORKDIR /usr/src/app

# 5. 의존성 설치
COPY package*.json ./
RUN npm install

# 6. 소스 코드 복사
COPY . .

# 7. 포트 설정
EXPOSE 3000

# 8. 앱 실행
CMD [ "node", "server.js" ]
