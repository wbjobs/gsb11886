# 屏幕空间特效实验室（WebGL）

用 WebGL2 实现的屏幕空间特效演示：**SSR（屏幕空间反射）、SSAO（屏幕空间环境遮蔽）、
景深（DoF）、运动模糊**，支持实时参数调整、量化性能对照、自动/手动降级与场景切换。

- 渲染：WebGL2（MRT G-buffer + 全屏 raymarch 场景），WebGL1 前向降级
- 线程：Web Worker + OffscreenCanvas 承载渲染主循环；主线程仅负责 UI 与调度
- 监控：`PerformanceObserver`（`longtask` 条目）量化主线程卡顿
- 持久化：IndexedDB 保存最近参数与跑分历史
- 零构建、零外部依赖，直接用静态服务器打开 `index.html`

## 运行

```bash
cd B
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

> 不要用 `file://` 直接打开：Worker 脚本与模块需要同源 HTTP 环境。

## 渲染管线

G-buffer（单 Pass、3 个 MRT 附件）：

| 附件 | 内容 |
| --- | --- |
| `COLOR` | HDR 基础着色（Blinn-Phong + 菲涅尔 + 自发光） |
| `DATA0` | rg 视图空间法线、b 线性深度、a 粗糙度 |
| `DATA1` | rg 屏幕空间速度（NDC/帧）、b 金属度、a 物体 id |

后处理链（全部可独立开关、随质量档位调整采样预算）：

1. **SSAO**：半球核采样 + 4×4 旋转噪声 + 深度感知双边模糊，输出单通道遮蔽
2. **SSR**：视图空间步进 + 二分细化，粗糙度驱动 Poisson 反射模糊，菲涅尔/金属度加权
3. **DoF**：线性深度重建 CoC，24 tap 双环采样，前景/背景分别累积混合
4. **运动模糊**：3×3 邻域最大速度膨胀，深度边缘降权，像素速度限制
5. **Output**：ACES tonemap、gamma 2.2、暗角；另提供 6 种调试缓冲视图

场景为程序化 SDF 射线步进（平面、球、盒、圆角盒），房间平面叠加 value-noise 微凹凸，
即“深度纹理/法线纹理”的程序化来源；深度与法线同时以独立 G-buffer 附件暴露在调试视图中。

## 性能取舍与降级

质量档位（`js/renderer/gl-renderer.js` 中的 `LEVELS`）：

| 档位 | 分辨率比例 | SSR 步数 | SSAO 采样 | 运动采样 | 后期 Pass |
| --- | --- | --- | --- | --- | --- |
| L0 无后期 | 1.0 | – | – | – | 2 |
| L1 低 | 0.5 | 16 | 8 | 4 | 7 |
| L2 中 | 0.75 | 28 | 16 | 8 | 7 |
| L3 高 | 1.0 | 40 | 28 | 12 | 7 |

- **自动降级**：连续 2 个 1 秒统计窗口 FPS < 45 时降一档（有冷却），顶栏出现横幅
- **手动降级**：下拉直接切到 L0，所有后期 Pass 关闭（对应“降级到无后期”）
- **后端降级**：不支持 OffscreenCanvas/Worker → 主线程渲染（UI 标注对照模式）；
  不支持 WebGL2 → WebGL1 前向路径（无后期）；无 WebGL → 明确错误面板
- **精度降级**：缺少 `EXT_color_buffer_float` 时 HDR 附件自动回退 RGBA8

## 性能对照（Benchmark）

点击「跑分：L0→L3 各 240 帧」：每档 60 帧预热 + 240 帧测量，自动环绕相机，
输出每档 FPS、ms/帧、Pass 数，绘制柱状图，并统计**跑分区间内主线程 longtask 数**。
Worker 路径下该数应接近 0；勾选「禁用 Worker」整页刷新后可跑主线程对照组。
记录写入 IndexedDB（保留最近 20 次），可一键清除。

## 操作

- 拖拽旋转、滚轮缩放；「自动环绕」产生相机运动模糊
- 「在画面中点击选取焦点」后点画布，用该像素线性深度设置对焦距离
- 调试可视化：线性深度 / 视图法线 / 速度向量 / SSAO / SSR 命中遮罩 / CoC / 基础着色

## 验收标准对照

| 验收项 | 对应实现 |
| --- | --- |
| SSR 正确 | 视图空间反射步进 + 深度命中 + 粗糙度模糊，`SSR 命中遮罩` 调试视图 |
| SSAO 正确 | 半球核 + 双边模糊，立柱走廊缝隙可见遮蔽，`SSAO 遮蔽` 调试视图 |
| 景深正确 | CoC 随对焦距离/光圈/范围变化，前景遮挡式混合，`景深 CoC` 视图 + 点击取焦 |
| 运动模糊正确 | 运动球与相机旋转产生沿速度方向拖影，`速度向量` 调试视图 |
| 参数调整正确 | 每个 Pass 的步数/半径/强度等滑块实时下发（500ms 防抖存 IndexedDB） |
| 性能对照可量化 | Benchmark L0–L3 FPS/帧耗时/Pass 数柱状图 + 主线程 longtask 计数 |
| 降级方案可用 | L0 手动、<45fps 自动、Worker 不可用主线程、WebGL1 前向、无 WebGL 错误提示 |
| 场景切换正确 | 三个预设独立相机机位与运动体，切换即重置相机 |
| 主线程不卡 | 渲染在 Worker 中；PerformanceObserver longtask 计数实时显示 |
| 可视化准确 | 7 种缓冲调试视图 + 跑分图表 + HUD（fps / ms / 长任务 / 模式） |

## 目录

```
index.html                  页面与控制面板
css/app.css                 样式
js/renderer/mat4.js         矩阵（perspective/lookAt/invert）
js/renderer/camera.js       轨道相机
js/renderer/scenes.js       三个程序化场景与运动体
js/renderer/shaders/*.js    G-buffer / SSAO / SSR / DoF / 运动模糊 / 输出 / WebGL1 降级
js/renderer/gl-renderer.js  FBO、Pass 调度、质量分级、自动降级、Benchmark
js/db.js                    IndexedDB 封装
js/perf-monitor.js          PerformanceObserver longtask 监控
js/ui.js                    控件绑定与跑分图表
js/main.js                  后端选择（Worker/主线程）、消息路由、相机输入
worker/render-worker.js     Worker：OffscreenCanvas + rAF 渲染循环
```
