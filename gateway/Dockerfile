# parpaing-gateway: the only port of parpaing, nginx with the web page and the brand kit inside.
FROM nginx:1.30.6-alpine
COPY gateway/nginx.conf /etc/nginx/conf.d/default.conf
COPY gateway/index.html /srv/page/index.html
COPY gateway/app.js /srv/page/app.js
COPY docs/brand /srv/brand
