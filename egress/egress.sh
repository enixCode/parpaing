#!/bin/sh
# The only way out for sandboxes. Each sandbox sits alone in an internal network where this proxy has a leg; whatever a
# sandbox asks, the kernel of this container refuses private, link-local and metadata destinations (DNS rebinding included),
# then GOST relays the rest. Rules live in this container's own network namespace, never on the host.
set -eu
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$net" -j REJECT
done
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -j REJECT
exec gost -C /etc/gost/gost.yaml
