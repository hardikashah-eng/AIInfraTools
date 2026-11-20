# chrony plus the clock check, for the DaemonSet in deploy/chrony-daemonset.yaml.
# Build and push to your own registry (on-prem clusters are often air-gapped):
#   docker build -t <registry>/chrony-clock:4 -f clock/Dockerfile clock
FROM alpine:3.20
RUN apk add --no-cache chrony bash
COPY check-clock.sh /usr/local/bin/check-clock.sh
RUN chmod +x /usr/local/bin/check-clock.sh
ENTRYPOINT ["chronyd", "-d", "-f", "/etc/chrony/chrony.conf"]
