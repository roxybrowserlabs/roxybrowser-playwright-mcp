/**
 * 生成拟人化的鼠标轨迹点
 * 使用贝塞尔曲线和轻微随机化模拟人类鼠标移动
 */
export function generateHumanMousePath(startX, startY, endX, endY, steps = 20) {
  const points = [];

  // 生成控制点（创建轻微的弧形轨迹）
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const offset = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2)) * 0.15;
  const controlX = midX + (Math.random() - 0.5) * offset;
  const controlY = midY + (Math.random() - 0.5) * offset;

  // 使用二次贝塞尔曲线生成轨迹点
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 缓动函数：开始快，结束慢
    const easedT = 1 - Math.pow(1 - t, 3);

    const x = Math.pow(1 - easedT, 2) * startX +
              2 * (1 - easedT) * easedT * controlX +
              Math.pow(easedT, 2) * endX;
    const y = Math.pow(1 - easedT, 2) * startY +
              2 * (1 - easedT) * easedT * controlY +
              Math.pow(easedT, 2) * endY;

    // 添加微小的随机抖动
    const jitter = i < steps ? (Math.random() - 0.5) * 2 : 0;

    points.push({
      x: x + jitter,
      y: y + jitter,
      pause: i === 0 ? 50 : i === steps ? 100 : 10 + Math.random() * 10
    });
  }

  return points;
}

/**
 * 执行拟人化的点击操作
 */
export async function humanClick(tab, locator, params) {
  // 首先确保元素可见并滚动到视图中
  await locator.scrollIntoViewIfNeeded();

  const page = tab.page;
  const box = await locator.boundingBox();
  if (!box) {
    // 如果无法获取 boundingBox，回退到标准点击
    const options = {
      button: params.button,
      modifiers: params.modifiers
    };
    if (params.doubleClick) {
      await locator.dblclick(options);
    } else {
      await locator.click(options);
    }
    return;
  }

  // 计算目标点（元素中心带轻微随机偏移）
  const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * Math.min(box.width * 0.3, 10);
  const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * Math.min(box.height * 0.3, 10);

  // 获取当前鼠标位置，或从一个合理的位置开始
  let startX, startY;
  try {
    startX = await page.evaluate(() => window.__lastMouseX);
    startY = await page.evaluate(() => window.__lastMouseY);
    if (typeof startX !== 'number' || typeof startY !== 'number') {
      startX = 100 + Math.random() * 300;
      startY = 100 + Math.random() * 300;
    }
  } catch {
    startX = 100 + Math.random() * 300;
    startY = 100 + Math.random() * 300;
  }

  // 生成轨迹
  const points = generateHumanMousePath(startX, startY, targetX, targetY);

  // 沿轨迹移动鼠标
  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(point.pause);
  }

  // 保存最后的鼠标位置
  try {
    await page.evaluate((x, y) => {
      window.__lastMouseX = x;
      window.__lastMouseY = y;
    }, targetX, targetY);
  } catch {
    // 忽略错误
  }

  // 构建点击选项
  const options = {
    button: params.button,
    modifiers: params.modifiers
  };

  // 执行点击
  if (params.doubleClick) {
    await page.mouse.down(options);
    await page.waitForTimeout(50 + Math.random() * 50);
    await page.mouse.up(options);
    await page.waitForTimeout(100 + Math.random() * 100);
    await page.mouse.down(options);
    await page.waitForTimeout(50 + Math.random() * 50);
    await page.mouse.up(options);
  } else {
    await page.mouse.down(options);
    await page.waitForTimeout(50 + Math.random() * 100);
    await page.mouse.up(options);
  }
}
