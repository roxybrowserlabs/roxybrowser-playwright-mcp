import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestBrowser } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("browser context route contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("intercepts through context.route like Playwright", async () => {
    const browser = await connectTestBrowser();
    try {
      const context = await browser.newContext();
      try {
        let intercepted = false;
        await context.route("**/empty.html", async (route) => {
          intercepted = true;
          const request = route.request();
          expect(request.url()).toContain("empty.html");
          expect(request.headers()["user-agent"]).toBeTruthy();
          expect(request.method()).toBe("GET");
          expect(request.postData()).toBe(null);
          expect(request.isNavigationRequest()).toBe(true);
          expect(request.resourceType()).toBe("document");
          await route.continue();
        });

        const page = await context.newPage();
        try {
          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(response?.ok()).toBe(true);
          expect(intercepted).toBe(true);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("supports context.unroute lifecycle like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          let intercepted: number[] = [];
          await context.route("**/*", async (route) => {
            intercepted.push(1);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(2);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(3);
            await route.fallback();
          });
          const handler4 = async (route: Parameters<typeof context.route>[1] extends infer T ? T extends (...args: any[]) => any ? Parameters<T>[0] : never : never) => {
            intercepted.push(4);
            await route.fallback();
          };

          await context.route(/empty.html/, handler4 as never);
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([4, 3, 2, 1]);

          intercepted = [];
          await context.unroute(/empty.html/, handler4 as never);
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([3, 2, 1]);

          intercepted = [];
          await context.unroute("**/empty.html");
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([1]);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("context.unroute does not wait for pending handlers to complete like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          let secondHandlerCalled = false;
          await context.route(/.*/, async (route) => {
            secondHandlerCalled = true;
            await route.continue();
          });

          let routeCallback!: () => void;
          const routePromise = new Promise<void>((resolve) => {
            routeCallback = resolve;
          });
          let continueRouteCallback!: () => void;
          const routeBarrier = new Promise<void>((resolve) => {
            continueRouteCallback = resolve;
          });
          const handler = async (route: Parameters<typeof context.route>[1] extends infer T
            ? T extends (...args: any[]) => any
              ? Parameters<T>[0]
              : never
            : never) => {
            routeCallback();
            await routeBarrier;
            await route.fallback();
          };

          await context.route(/.*/, handler as never);
          const navigationPromise = page.goto(fixture.server.EMPTY_PAGE);
          await routePromise;
          await withTimeout(context.unroute(/.*/, handler as never), "context.unroute", 1000);
          continueRouteCallback();
          await navigationPromise;

          expect(secondHandlerCalled).toBe(true);
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
    }
  });

  it("context.unrouteAll removes all handlers like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          await context.route("**/*", (route) => route.abort());
          await context.route("**/empty.html", (route) => route.abort());

          await context.unrouteAll();

          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(response?.ok()).toBe(true);
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
    }
  });

  it("context.unrouteAll ignores pending handler errors without waiting like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          let secondHandlerCalled = false;
          await context.route(/.*/, async () => {
            secondHandlerCalled = true;
          });

          let routeCallback!: () => void;
          const routePromise = new Promise<void>((resolve) => {
            routeCallback = resolve;
          });
          let continueRouteCallback!: () => void;
          const routeBarrier = new Promise<void>((resolve) => {
            continueRouteCallback = resolve;
          });

          await context.route(/.*/, async () => {
            routeCallback();
            await routeBarrier;
            throw new Error("Handler error");
          });

          const navigationPromise = page.goto(fixture.server.EMPTY_PAGE).catch((error) => error);
          await routePromise;

          let didUnroute = false;
          await withTimeout(
            context.unrouteAll({ behavior: "ignoreErrors" }).then(() => {
              didUnroute = true;
            }),
            "context.unrouteAll",
            1000
          );
          expect(didUnroute).toBe(true);

          continueRouteCallback();
          await navigationPromise;
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(secondHandlerCalled).toBe(false);
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
    }
  });

  it("context.close does not wait for active route handlers on owned pages like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        let routeCallback!: () => void;
        const routePromise = new Promise<void>((resolve) => {
          routeCallback = resolve;
        });

        await page.route(/.*/, async () => {
          routeCallback();
        });
        await page.route(/.*/, async (route) => {
          await route.fallback();
        });

        void page.goto(fixture.server.EMPTY_PAGE).catch(() => {});
        await routePromise;
        await withTimeout(context.close(), "context.close", 1000);
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      await browser.close().catch(() => {});
    }
  });

  it("yields to page.route before context.route like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        await context.route("**/empty.html", async (route) => {
          await route.fulfill({ status: 200, body: "context" });
        });
        const page = await context.newPage();
        try {
          await page.route("**/empty.html", async (route) => {
            await route.fulfill({ status: 200, body: "page" });
          });
          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(response?.ok()).toBe(true);
          expect(await response?.text()).toBe("page");
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("falls back from page.route to context.route like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        await context.route("**/empty.html", async (route) => {
          await route.fulfill({ status: 200, body: "context" });
        });
        const page = await context.newPage();
        try {
          await page.route("**/non-empty.html", async (route) => {
            await route.fulfill({ status: 200, body: "page" });
          });
          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(response?.ok()).toBe(true);
          expect(await response?.text()).toBe("context");
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("supports the times parameter with context.route like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          const intercepted: number[] = [];
          await context.route("**/empty.html", async (route) => {
            intercepted.push(1);
            await route.continue();
          }, { times: 1 });

          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });

          expect(intercepted).toHaveLength(1);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("works if a times route handler is removed by another context handler like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          const intercepted: string[] = [];
          const handler = async (route: Parameters<typeof context.route>[1] extends infer T ? T extends (...args: any[]) => any ? Parameters<T>[0] : never : never) => {
            intercepted.push("first");
            await route.continue();
          };

          await context.route("**/*", handler as never, { times: 1 });
          await context.route("**/*", async (route) => {
            intercepted.push("second");
            await context.unroute("**/*", handler as never);
            await route.fallback();
          });

          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual(["second"]);

          intercepted.length = 0;
          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual(["second"]);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("chains context fallback like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          const intercepted: number[] = [];
          await context.route("**/empty.html", async (route) => {
            intercepted.push(1);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(2);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(3);
            await route.fallback();
          });

          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([3, 2, 1]);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("chains context fallback with dynamic URL like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          const intercepted: number[] = [];
          await context.route("**/bar", async (route) => {
            intercepted.push(1);
            await route.fallback({ url: fixture.server.EMPTY_PAGE });
          });
          await context.route("**/foo", async (route) => {
            intercepted.push(2);
            await route.fallback({ url: "http://localhost/bar" });
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(3);
            await route.fallback({ url: "http://localhost/foo" });
          });

          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([3, 2, 1]);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("overwrites post body with empty string through context.route like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          await context.route("**/empty.html", async (route) => {
            await route.continue({
              postData: ""
            });
          });

          const [request] = await Promise.all([
            fixture.server.waitForRequest("/empty.html"),
            page.setContent(`
              <script>
                (async () => {
                  await fetch(${JSON.stringify(fixture.server.EMPTY_PAGE)}, {
                    method: "POST",
                    body: "original",
                  });
                })();
              </script>
            `)
          ]);

          const body = (await request.postBody).toString();
          expect(body).toBe("");
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("does not chain fulfill after context fallback like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          let failed = false;
          await context.route("**/empty.html", async () => {
            failed = true;
          });
          await context.route("**/empty.html", async (route) => {
            await route.fulfill({ status: 200, body: "fulfilled" });
          });
          await context.route("**/empty.html", async (route) => {
            await route.fallback();
          });

          const response = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(await response?.text()).toBe("fulfilled");
          expect(failed).toBe(false);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("does not chain abort after context fallback like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          let failed = false;
          await context.route("**/empty.html", async () => {
            failed = true;
          });
          await context.route("**/empty.html", async (route) => {
            await route.abort();
          });
          await context.route("**/empty.html", async (route) => {
            await route.fallback();
          });

          const error = await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" }).catch((caught) => caught);
          expect(error).toBeTruthy();
          expect(failed).toBe(false);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("chains context fallback into page routes like Playwright", async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        try {
          const intercepted: number[] = [];
          await context.route("**/empty.html", async (route) => {
            intercepted.push(1);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(2);
            await route.fallback();
          });
          await context.route("**/empty.html", async (route) => {
            intercepted.push(3);
            await route.fallback();
          });
          await page.route("**/empty.html", async (route) => {
            intercepted.push(4);
            await route.fallback();
          });
          await page.route("**/empty.html", async (route) => {
            intercepted.push(5);
            await route.fallback();
          });
          await page.route("**/empty.html", async (route) => {
            intercepted.push(6);
            await route.fallback();
          });

          await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
          expect(intercepted).toEqual([6, 5, 4, 3, 2, 1]);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
