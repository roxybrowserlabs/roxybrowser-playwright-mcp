# Firefox BiDi 模式下后台窗口点击失效问题 — 修复说明

This document is a hand-off note for the RoxyBrowser desktop app team. It
describes a bug reproduced against RoxyBrowser-managed Firefox (BiDi) profiles
and the fix needed on the RoxyBrowser side. It intentionally does not propose
any change to this repository's `src/protocol/bidi/backend.ts` — see
"结论：本仓库不需要改动" below for why.

## 现象

通过 RoxyBrowser API 的 `browser_open` 打开一个 Firefox（BiDi 内核）profile
后，如果这个窗口不是当前系统焦点窗口（比如多个 profile 并行跑自动化任务时，
另一个窗口正好在前台），通过 WebDriver BiDi 的 `input.performActions` 发送
的鼠标点击不会生效——页面上的 click 事件监听器收不到事件，但同样在后台状态
下 `input.performActions` 的键盘输入（fill/type）却是正常的。

## 根因

WebDriver BiDi 协议本身没有"让后台窗口在不抢占系统焦点的前提下正常响应合成
输入"这种运行时命令。协议里唯一和焦点相关的命令是 `browsingContext.activate`，
但它会真实抢占 OS 窗口焦点，多开场景下会导致窗口互相抢焦点，不能作为点击前
的常规操作。

Firefox 自己的做法是通过几个 **profile 级别的 preference（写在 profile 目录
下的 `prefs.js` 里）**，让 Firefox 把自己"当作"始终有焦点，从而使指针事件即
便在窗口未获得真实 OS 焦点时也能正常派发。这些 preference 只在 Firefox 进程
启动、加载该 profile 时生效一次，不需要每次操作前额外发命令。

这不是猜测——这是微软 Playwright 官方对 Firefox/BiDi 后端的处理方式，可以在
其源码里直接确认（Playwright 从不在点击前调用 `browsingContext.activate`，
只在用户主动调用"bring to front"这类 API 时才用它）：

- `packages/playwright-core/src/server/bidi/third_party/firefoxPrefs.ts`
- `packages/playwright-core/src/server/bidi/bidiFirefox.ts`（`createProfile()`
  在启动前把这些 preference 写进 profile）

## 结论：本仓库不需要改动

本仓库自身的 BiDi 点击路径（`src/protocol/bidi/backend.ts`）已经和 upstream
Playwright 完全一致——从不在点击前调用 `browsingContextActivate`，只在
`bringToFront()` 里调用。这一行为被 `tests/unit/bidiBackend.test.ts` 的
"keeps BiDi locator input in the target unless activation is explicit" 测试
显式锁定。

真正复现"后台窗口点击失效"的场景是 RoxyBrowser 桌面应用托管的 Firefox
profile（通过 `browser_open` API 打开）——Firefox 进程的 spawn 和 profile 初
始化完全在 RoxyBrowser 代码里，不在本仓库控制范围内。修复需要落在
RoxyBrowser 那边的 Firefox profile 初始化逻辑上。

## 需要加的 Preference

**关键的一条（直接对应本次问题）：**

```
focusmanager.testmode = true
```

含义：允许应用程序即便运行在后台也保持"有焦点"状态（Playwright 源码原话注释：
"Allow the application to have focus even it runs in the background"）。这
条决定了后台窗口能不能正常响应指针事件。

**建议一起加的一条（影响后台标签页渲染/rAF 节流，不直接影响点击，但影响后台
页面行为的一致性）：**

```
layout.testing.top-level-always-active = true
```

含义：后台标签页不降频渲染（不节流 requestAnimationFrame）。

**可选，如果以后要跑高并发场景，建议也加上（避免后台窗口的计时器被节流导致
自动化脚本里的延时/轮询变慢）：**

```
dom.min_background_timeout_value = 0
dom.min_background_timeout_value_without_budget_throttling = 0
dom.timeout.enable_budget_timer_throttling = false
```

## 怎么加

Firefox 的 preference 是 profile 级别的，有两种落地方式，选其中一种即可：

**方式一：在创建/准备 Firefox profile 目录时写入 `prefs.js`**（Playwright 采
用的方式）

在 profile 目录初始化阶段（也就是 RoxyBrowser 内部生成/复用 Firefox
profile、准备好目录之后，Firefox 进程真正 spawn 之前），把上述 key-value 写
进该 profile 目录下的 `prefs.js` 文件，格式为：

```
user_pref("focusmanager.testmode", true);
user_pref("layout.testing.top-level-always-active", true);
```

如果 profile 目录下已经有 `prefs.js`（比如复用已存在的 profile），需要追加
而不是覆盖已有内容。

**方式二：在 profile 目录下放一个 `user.js`**

`user.js` 和 `prefs.js` 语法完全一样，Firefox 每次启动加载该 profile 时都会
读取 `user.js` 并覆盖对应的 pref。如果不方便在代码里操作 `prefs.js`（比如
profile 生成逻辑复杂、时序不好插入），放一个静态的 `user.js` 到每个新建
profile 目录下更简单，一次写入，长期生效。

两种方式效果等价，选哪个取决于 RoxyBrowser 现有 profile 初始化代码的结构，
怎么改动小就选哪个。

## 验证方法

改完之后，验证方式：

1. 打开两个 Firefox（BiDi）profile 窗口，让窗口 B 处于系统前台（有真实 OS
   焦点）。
2. 对窗口 A（后台、无 OS 焦点）通过 BiDi 的 `input.performActions` 发送一次
   鼠标点击，点击一个带 click 监听器的元素。
3. 修复前：点击不生效（元素状态不变）。修复后：点击应该正常触发，和窗口在
   前台时表现一致。

也可以直接用 Playwright 自己的 Firefox 构建对比：Playwright 官方发布的
Firefox（`playwright-firefox`）已经内置了这些 preference，行为上后台点击是
正常的，可以作为对照组。

## 补充说明

这个问题和"`browser_open` 接口偶发超时"是两个独立问题，超时是 API 层面的问
题，会在本仓库自己的重试逻辑里处理，不需要 RoxyBrowser 改动。这份文档只针对
"后台窗口点击失效"这一个问题。
