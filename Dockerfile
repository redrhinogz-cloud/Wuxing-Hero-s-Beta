FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
ENV WUXING_DATA_DIR=/var/lib/wuxing
RUN mkdir -p /var/lib/wuxing
EXPOSE 8080
CMD ["node", "server.js"]
