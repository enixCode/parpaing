# parpaing-gateway: the only port of parpaing, nginx with the web page, the API reference and the brand kit inside.
FROM nginx:1.30.6-alpine
COPY gateway/default.conf.template /etc/nginx/templates/default.conf.template
COPY gateway/index.html /srv/page/index.html
COPY gateway/app.js /srv/page/app.js
COPY gateway/docs.html /srv/docs/index.html
# Scalar draws the API reference. Pinned by its checksum: a changed file fails the build.
ADD --checksum=sha256:db9d00b7ee9259ef90554cbf8b6b0f671c9e0fe8540a33d845630fee68cbb966 --chmod=644 https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.78.1/dist/browser/standalone.js /srv/docs/scalar.js
COPY docs/brand /srv/brand
