#include <stddef.h>
#include <stdint.h>

void *memcpy(void *destination, const void *source, size_t count) {
    uint8_t *dst = (uint8_t *)destination;
    const uint8_t *src = (const uint8_t *)source;
    size_t i;
    for (i = 0u; i < count; ++i) {
        dst[i] = src[i];
    }
    return destination;
}

void *memmove(void *destination, const void *source, size_t count) {
    uint8_t *dst = (uint8_t *)destination;
    const uint8_t *src = (const uint8_t *)source;
    size_t i;
    if (dst == src || count == 0u) {
        return destination;
    }
    if (dst < src) {
        for (i = 0u; i < count; ++i) {
            dst[i] = src[i];
        }
    } else {
        for (i = count; i != 0u; --i) {
            dst[i - 1u] = src[i - 1u];
        }
    }
    return destination;
}

void *memset(void *destination, int value, size_t count) {
    uint8_t *dst = (uint8_t *)destination;
    size_t i;
    for (i = 0u; i < count; ++i) {
        dst[i] = (uint8_t)value;
    }
    return destination;
}

int memcmp(const void *left, const void *right, size_t count) {
    const uint8_t *a = (const uint8_t *)left;
    const uint8_t *b = (const uint8_t *)right;
    size_t i;
    for (i = 0u; i < count; ++i) {
        if (a[i] != b[i]) {
            return a[i] < b[i] ? -1 : 1;
        }
    }
    return 0;
}
