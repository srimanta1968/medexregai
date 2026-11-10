# fda-data service image: one image, two processes (API: dist/index.js, worker: dist/worker.js).
FROM node:20.18.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev

FROM node:20.18.1-alpine
WORKDIR /app
ENV NODE_ENV=production
# Amazon RDS CA bundle so FDA_DB_SSL=true can verify the database certificate.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 4100
CMD ["node", "dist/index.js"]
