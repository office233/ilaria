#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "swypik/arch/x86_64/driver_image.h"

#define PROBE_MAX_IMAGE_BYTES (2u * 1024u * 1024u)

/* Link-only stubs for loader-only dependencies in driver_image.c.
   The probe invokes only swyp_x86_driver_image_parse; these functions are never
   called by the parser and deliberately provide no simulated loader behavior. */
SwypAddressSpace *swyp_x86_64_address_space_contract(SwypX86AddressSpace *space) {
    (void)space;
    return NULL;
}

SwypX86AddressSpace *swyp_x86_64_driver_runtime_x86_space(SwypX86DriverRuntimeManager *manager,
                                                          uint64_t domain_id,
                                                          uint64_t lease_fence) {
    (void)manager;
    (void)domain_id;
    (void)lease_fence;
    return NULL;
}

static int read_image(const char *path, uint8_t **out_data, uint64_t *out_size) {
    FILE *file;
    long size;
    uint8_t *data;
    size_t read_bytes;

    if (path == NULL || out_data == NULL || out_size == NULL) {
        return 0;
    }
    file = fopen(path, "rb");
    if (file == NULL) {
        return 0;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return 0;
    }
    size = ftell(file);
    if (size < 0 || (uint64_t)size > PROBE_MAX_IMAGE_BYTES || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return 0;
    }
    data = (uint8_t *)malloc(size == 0 ? 1u : (size_t)size);
    if (data == NULL) {
        fclose(file);
        return 0;
    }
    read_bytes = size == 0 ? 0u : fread(data, 1u, (size_t)size, file);
    if (fclose(file) != 0 || read_bytes != (size_t)size) {
        free(data);
        return 0;
    }
    *out_data = data;
    *out_size = (uint64_t)size;
    return 1;
}

static void print_segment(const SwypX86DriverImageSegment *segment) {
    printf("{\"virtual_offset\":%" PRIu64 ",\"file_offset\":%" PRIu64
           ",\"file_size\":%" PRIu64 ",\"memory_size\":%" PRIu64
           ",\"flags\":%" PRIu64 "}",
           segment->virtual_offset,
           segment->file_offset,
           segment->file_size,
           segment->memory_size,
           segment->flags);
}

int main(int argc, char **argv) {
    uint8_t *image = NULL;
    uint64_t image_bytes = 0u;
    SwypX86DriverImageInfo info = {0};
    SwypStatus status;
    uint16_t i;

    if (argc != 2) {
        fputs("usage: c-probe IMAGE\n", stderr);
        return 2;
    }
    if (!read_image(argv[1], &image, &image_bytes)) {
        fputs("failed to read bounded probe image\n", stderr);
        return 2;
    }

    status = swyp_x86_driver_image_parse(image, image_bytes, &info);
    free(image);

    if (status != SWYP_OK) {
        printf("{\"accepted\":false,\"status\":%d}\n", (int)status);
        return 0;
    }

    printf("{\"accepted\":true,\"status\":%d,\"entry_rva\":%" PRIu64
           ",\"image_span\":%" PRIu64 ",\"segment_count\":%u,\"total_pages\":%u,\"segments\":[",
           (int)status,
           info.entry_rva,
           info.image_span,
           (unsigned)info.segment_count,
           (unsigned)info.total_pages);
    for (i = 0u; i < info.segment_count; ++i) {
        if (i != 0u) {
            putchar(',');
        }
        print_segment(&info.segments[i]);
    }
    fputs("]}\n", stdout);
    return 0;
}
