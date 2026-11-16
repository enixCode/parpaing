# The egress proxy: GOST v3 (MIT), the official image pinned by digest, plus iptables for the rules egress.sh sets.
FROM gogost/gost:3.3.3@sha256:f266f957c6e4f8d433ed23202a5745fa4969d08f3f0ef034fb9357345e16ad67
RUN apk add --no-cache iptables ip6tables
COPY egress/egress.sh /egress.sh
COPY egress/gost.yaml /etc/gost/gost.yaml
ENTRYPOINT ["sh", "/egress.sh"]
