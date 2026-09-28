#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int parse_double(const char *text, double *value) {
    char *end = NULL;
    errno = 0;
    *value = strtod(text, &end);
    return errno == 0 && end != text && *end == '\0' && *value >= 0.0;
}

static int parse_u64(const char *text, uint64_t *value) {
    char *end = NULL;
    unsigned long long parsed;
    if (text[0] == '-') {
        return 0;
    }
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0') {
        return 0;
    }
    *value = (uint64_t)parsed;
    return 1;
}

int main(int argc, char **argv) {
    double boot_ms;
    double ipc_roundtrip_ns;
    uint64_t memory_overhead_bytes;
    double fault_recovery_ms;
    const char *status;
    if (argc != 8) {
        fprintf(stderr, "usage: %s <implementation> <environment> <boot_ms> <ipc_ns> <memory_bytes> <fault_ms> <measured|placeholder>\n", argv[0]);
        return 2;
    }
    if (!parse_double(argv[3], &boot_ms) || !parse_double(argv[4], &ipc_roundtrip_ns) ||
        !parse_u64(argv[5], &memory_overhead_bytes) || !parse_double(argv[6], &fault_recovery_ms)) {
        fputs("invalid numeric benchmark value\n", stderr);
        return 2;
    }
    status = argv[7];
    if (strcmp(status, "measured") != 0 && strcmp(status, "placeholder") != 0) {
        fputs("status must be measured or placeholder\n", stderr);
        return 2;
    }
    printf("{\"schema_version\":1,\"implementation\":\"%s\",\"environment\":\"%s\","
           "\"boot_ms\":%.3f,\"ipc_roundtrip_ns\":%.3f,\"memory_overhead_bytes\":%llu,"
           "\"fault_recovery_ms\":%.3f,\"status\":\"%s\"}\n",
           argv[1], argv[2], boot_ms, ipc_roundtrip_ns, (unsigned long long)memory_overhead_bytes,
           fault_recovery_ms, status);
    return 0;
}
