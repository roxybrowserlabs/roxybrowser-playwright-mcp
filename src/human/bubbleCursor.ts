export const BUBBLE_CURSOR_INSTALL_SOURCE = `(() => {
  const globalState = globalThis;
  if (globalState.__roxyBubbleCursor?.installed) {
    return true;
  }

  const prefersReducedMotion = globalState.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (prefersReducedMotion?.matches) {
    globalState.__roxyBubbleCursor = {
      installed: false,
      reducedMotion: true
    };
    return false;
  }

  class Particle {
    constructor(x, y) {
      this.initialLifeSpan = Math.floor(Math.random() * 60 + 60);
      this.lifeSpan = this.initialLifeSpan;
      this.velocity = {
        x: (Math.random() < 0.5 ? -1 : 1) * (Math.random() / 10),
        y: -0.4 + Math.random() * -1
      };
      this.position = { x, y };
      this.baseDimension = 4;
    }

    update(context) {
      this.position.x += this.velocity.x;
      this.position.y += this.velocity.y;
      this.velocity.x += ((Math.random() < 0.5 ? -1 : 1) * 2) / 75;
      this.velocity.y -= Math.random() / 600;
      this.lifeSpan -= 1;

      const scale = 0.2 + (this.initialLifeSpan - this.lifeSpan) / this.initialLifeSpan;

      context.fillStyle = '#e6f1f7';
      context.strokeStyle = '#3a92c5';
      context.beginPath();
      context.arc(
        this.position.x - (this.baseDimension / 2) * scale,
        this.position.y - this.baseDimension / 2,
        this.baseDimension * scale,
        0,
        2 * Math.PI
      );
      context.stroke();
      context.fill();
      context.closePath();
    }
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return false;
  }

  let particles = [];
  let animationFrameId = null;

  canvas.style.position = 'fixed';
  canvas.style.top = '0px';
  canvas.style.left = '0px';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '2147483647';

  const resize = () => {
    canvas.width = globalState.innerWidth;
    canvas.height = globalState.innerHeight;
  };

  const addParticle = (x, y) => {
    particles.push(new Particle(x, y));
  };

  const onPointerMove = (event) => {
    addParticle(event.clientX, event.clientY);
  };

  const onTouchMove = (event) => {
    for (const touch of event.touches) {
      addParticle(touch.clientX, touch.clientY);
    }
  };

  const updateParticles = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const particle of particles) {
      particle.update(context);
    }
    particles = particles.filter((particle) => particle.lifeSpan >= 0);
  };

  const loop = () => {
    updateParticles();
    animationFrameId = globalState.requestAnimationFrame(loop);
  };

  resize();
  document.documentElement.appendChild(canvas);
  document.addEventListener('mousemove', onPointerMove, true);
  document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  document.addEventListener('touchstart', onTouchMove, { passive: true, capture: true });
  globalState.addEventListener('resize', resize);
  loop();

  globalState.__roxyBubbleCursor = {
    installed: true,
    destroy: () => {
      document.removeEventListener('mousemove', onPointerMove, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchstart', onTouchMove, true);
      globalState.removeEventListener('resize', resize);
      if (animationFrameId !== null) {
        globalState.cancelAnimationFrame(animationFrameId);
      }
      particles = [];
      canvas.remove();
      delete globalState.__roxyBubbleCursor;
    }
  };

  return true;
})()`;
