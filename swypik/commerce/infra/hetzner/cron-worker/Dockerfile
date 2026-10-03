FROM alpine:3.20.3
RUN apk add --no-cache curl tzdata ca-certificates
COPY run.sh /run.sh
RUN addgroup -S swypik && adduser -S -G swypik swypik && chmod +x /run.sh
ENV TZ=Europe/Bucharest
USER swypik
ENTRYPOINT ["/bin/sh", "/run.sh"]
