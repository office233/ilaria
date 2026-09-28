import math
import sys
import time

def mandelbrot(width):
    height, py, checksum = width / 2, 0.0, 0.0
    while py < height:
        px = 0.0
        while px < width:
            cr, ci = px * 3.5 / width - 2.5, py * 2 / height - 1
            zr, zi, count = 0.0, 0.0, 0.0
            while count < 80 and zr * zr + zi * zi <= 4:
                nxt = zr * zr - zi * zi + cr
                zi = 2 * zr * zi + ci
                zr = nxt
                count = count + 1
            checksum = checksum + count
            px = px + 1
        py = py + 1
    return checksum

def prime(n):
    divisor = 2.0
    while divisor * divisor <= n:
        if math.fmod(n, divisor) == 0:
            return False
        divisor = divisor + 1
    return True

def primes(limit):
    n, count = 2.0, 0.0
    while n <= limit:
        if prime(n):
            count = count + 1
        n = n + 1
    return count

def train(epochs):
    weight, bias, epoch = 0.0, 0.0, 0.0
    while epoch < epochs:
        dw, db, i = 0.0, 0.0, 0.0
        while i < 256:
            x = math.fmod(i, 64) / 32 - 1
            target = 2 * x + 1
            error = weight * x + bias - target
            dw = dw + 2 * error * x
            db = db + 2 * error
            i = i + 1
        weight = weight - 0.1 * dw / 256
        bias = bias - 0.1 * db / 256
        epoch = epoch + 1
    loss, i = 0.0, 0.0
    while i < 256:
        x = math.fmod(i, 64) / 32 - 1
        error = weight * x + bias - (2 * x + 1)
        loss = loss + error * error
        i = i + 1
    loss = loss / 256
    print("WEIGHTS", weight, bias, loss)
    return loss

if __name__ == "__main__":
    mode, size = map(float, sys.argv[1:])
    start = time.perf_counter()
    result = (mandelbrot if mode == 0 else primes if mode == 1 else train)(size)
    print("RESULT", time.perf_counter() - start, result)
