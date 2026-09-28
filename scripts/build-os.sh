#!/usr/bin/env bash
# RAM-only live ISO. Never formats or writes a block device.
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in go cpio gzip modprobe depmod busybox grub-mkrescue xorriso; do
 command -v "$tool" >/dev/null || { echo "Missing build dependency: $tool" >&2; exit 1; }
done
[[ $(id -u) = 0 ]] || { echo 'Use an isolated root Linux builder for staged device nodes.' >&2; exit 1; }
KVER=${KERNEL_VERSION:-}
[[ $KVER =~ ^[0-9][A-Za-z0-9._+-]*$ ]] || { echo "Set KERNEL_VERSION to an explicit installed kernel version." >&2; exit 1; }
[[ -n $KVER && -f /boot/vmlinuz-$KVER && -d /lib/modules/$KVER ]] || { echo 'Matching kernel and modules are required.' >&2; exit 1; }
OUT=$(pwd)/out
mkdir -p "$OUT"
STAGE=$(mktemp -d "$OUT/stage.XXXXXX")
trap 'rm -rf -- "$STAGE"' EXIT
ROOT=$STAGE/root
ISO=$STAGE/iso
mkdir -p "$ROOT"/{bin,sbin,usr/bin,proc,sys,dev,etc/ssl/certs,run,tmp,home,var,root,usr/share/swypik} "$ISO/boot/grub"
cp -a system/rootfs/. "$ROOT/"
copy_bin() {
 local src dest library
 src=$(readlink -f "$1"); dest=$2
 install -D -m 0755 "$src" "$ROOT$dest"
 while read -r library; do
  [[ -f $library ]] && install -D -m 0755 "$library" "$ROOT$library"
 done < <(ldd "$src" 2>/dev/null | awk '/=> \//{print $3} /^[[:space:]]*\//{print $1}' | sort -u)
}
copy_bin "$(command -v busybox)" /bin/busybox
copy_bin "$(command -v kmod)" /bin/kmod
ln -s /bin/busybox "$ROOT/bin/sh"
ln -s /bin/kmod "$ROOT/sbin/modprobe"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$ROOT/usr/bin/swypikd" ./cmd/swypikd
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$ROOT/usr/bin/swypik-session" ./cmd/swypik-session
mkdir -p "$ROOT/lib/modules/$KVER"
for file in modules.builtin modules.builtin.modinfo modules.order; do
 [[ ! -f /lib/modules/$KVER/$file ]] || cp "/lib/modules/$KVER/$file" "$ROOT/lib/modules/$KVER/"
done
: > "$ROOT/usr/share/swypik/drivers.txt"
for module in virtio_pci virtio_net virtio_blk bochs evdev atkbd usbhid e1000 e1000e; do
 if dependencies=$(modprobe --set-version "$KVER" --show-depends "$module" 2>/dev/null); then
  printf '%s\n' "$module" >> "$ROOT/usr/share/swypik/drivers.txt"
  while read -r operation file rest; do
   [[ $operation = insmod ]] || continue
   install -D -m 0644 "$file" "$ROOT$file"
  done <<< "$dependencies"
 elif [[ $module = virtio_net || $module = virtio_pci || $module = evdev ]]; then
  echo "Required VM driver unavailable: $module" >&2; exit 1
 fi
done
depmod -b "$ROOT" "$KVER"
[[ ! -f /etc/ssl/certs/ca-certificates.crt ]] || cp /etc/ssl/certs/ca-certificates.crt "$ROOT/etc/ssl/certs/"
: > "$ROOT/etc/resolv.conf"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$ROOT/etc/hosts"
chmod 0755 "$ROOT/init" "$ROOT/etc/init.d/rcS" "$ROOT/etc/udhcpc.script" "$ROOT/usr/bin/start-swypikd"
chmod 0600 "$ROOT/etc/shadow"
mknod -m 0600 "$ROOT/dev/console" c 5 1
mknod -m 0666 "$ROOT/dev/null" c 1 3
cp /boot/vmlinuz-"$KVER" "$ISO/boot/vmlinuz"
{
 printf 'SwypikOS native boot prototype\nKernel: %s\n' "$KVER"
 go version
 printf "Source: %s\nWorking tree modified: %s\n" "${SOURCE_REVISION:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}" "${SOURCE_DIRTY:-$(if test -n "$(git status --porcelain 2>/dev/null)"; then echo true; else echo false; fi)}"
 [[ ! -f "$OUT/source-files.sha256" ]] || sha256sum "$OUT/source-files.sha256"
 dpkg-query -W -f='${Package} ${Version}\n' "linux-image-$KVER" busybox-static busybox kmod grub-pc-bin grub-efi-amd64-bin libc6 2>/dev/null || true
 printf '\nDrivers included:\n'; cat "$ROOT/usr/share/swypik/drivers.txt"
} > "$OUT/build-manifest.txt"
cp "$OUT/build-manifest.txt" "$ROOT/usr/share/swypik/build-manifest.txt"
# Preserve distributor notices. Public redistribution also requires matching
# corresponding sources for GPL components; see docs/NATIVE_OS.md.
mkdir -p "$ROOT/usr/share/licenses"
for package in busybox-static busybox kmod grub-common libc6 "linux-image-$KVER"; do
 [[ ! -f /usr/share/doc/$package/copyright ]] || cp /usr/share/doc/"$package"/copyright "$ROOT/usr/share/licenses/$package.txt"
done
(cd "$ROOT"; find . -print0 | sort -z | cpio --null -o --format=newc --owner=0:0 2>/dev/null | gzip -n -9) > "$ISO/boot/initramfs.gz"
cat > "$ISO/boot/grub/grub.cfg" <<'GRUB'
set timeout=0
set default=0
insmod all_video
set gfxpayload=1024x768x32
menuentry "SwypikOS - native RAM-only prototype" {
 linux /boot/vmlinuz console=tty0 console=ttyS0,115200 loglevel=4 panic=0 rdinit=/init
 initrd /boot/initramfs.gz
}
GRUB
grub-mkrescue --fonts='' -o "$OUT/swypik-os-native.iso" "$ISO"
cp "$ISO/boot/vmlinuz" "$OUT/vmlinuz"
cp "$ISO/boot/initramfs.gz" "$OUT/initramfs.gz"
(cd "$OUT"; sha256sum swypik-os-native.iso vmlinuz initramfs.gz build-manifest.txt > SHA256SUMS)
echo "Created $OUT/swypik-os-native.iso. Test in QEMU; not an installer or a production release."
