/**
 * Swypik Lightweight Confetti Launcher
 * 
 * Launcher de confetti de înaltă performanță pe HTML5 Canvas.
 * Zero dependențe externe, cleanup automat, efect dopaminic vibrant.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  rotationSpeed: number;
  opacity: number;
}

const COLORS = [
  "#7C3AED", // Violet Swypik
  "#EC4899", // Roz aprins
  "#F59E0B", // Auriu / Chihlimbar
  "#10B981", // Verde Smarald
  "#3B82F6", // Albastru Electric
  "#EF4444", // Roșu Coral
];

export function triggerConfetti(durationMs = 2500): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  try {
    const canvas = document.createElement("canvas");
    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "99999";
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.remove();
      return;
    }

    const width = (canvas.width = window.innerWidth);
    const height = (canvas.height = window.innerHeight);

    const particleCount = Math.min(100, Math.floor(width / 12));
    const particles: Particle[] = [];

    // Emitem particule din centru-jos / stânga-dreapta
    for (let i = 0; i < particleCount; i++) {
      const angle = (Math.random() * Math.PI * 0.8) + (Math.PI * 0.1); // între 18 și 162 grade în sus
      const speed = Math.random() * 12 + 8;
      particles.push({
        x: width * 0.5 + (Math.random() - 0.5) * 100,
        y: height * 0.75,
        vx: Math.cos(angle) * speed * (Math.random() > 0.5 ? 1 : -1),
        vy: -Math.sin(angle) * speed,
        size: Math.random() * 8 + 6,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 15,
        opacity: 1,
      });
    }

    const startTime = performance.now();

    const render = (now: number) => {
      const elapsed = now - startTime;
      if (elapsed > durationMs) {
        canvas.remove();
        return;
      }

      ctx.clearRect(0, 0, width, height);

      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.35; // gravitație
        p.vx *= 0.98; // rezistență aer
        p.rotation += p.rotationSpeed;
        p.opacity = Math.max(0, 1 - elapsed / durationMs);

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });

      requestAnimationFrame(render);
    };

    requestAnimationFrame(render);
  } catch {
    // Ignoră silențios
  }
}
