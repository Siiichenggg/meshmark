# meshmark

**在浏览器里，为一个已烘焙的三维场景标定物体和行走路线。**

[English](README.md)

指向一个网格文件，得到一个双视图标定器：写出带朝向的包围盒、中英双语类别标签、
以及带名字的地面路线，导出为 JSON。

```bash
npm install three                        # 装一次，装在哪都行
pip install -e .
meshmark build room.glb --out .annotate/room --classes generic
meshmark serve .annotate/room --open
```

不需要 Blender，不需要预处理，不联网 —— 构建出来的包是一个静态目录，
运行时不发出任何对外请求。

---

## 为什么是两个视图

单独任何一个都不够，这是整个设计的出发点。

**正交俯视底图**是能*量*出位置的地方：世界坐标到像素的映射是精确的，
页面上直接印着毫米/像素，没有透视可以争论。

**3D 视图**是能*认出*物体的地方，而这恰恰是俯视图经常做不到的 ——
从正上方看，一个垃圾桶和一摞叠好的布单长得差不多。

两个视图写的是同一份标注。在 3D 里点击网格放置，再在底图上用方向键
以厘米精度微调。

底图是在浏览器里从网格实时渲染的，所以移动切顶高度时它会重新渲染 ——
把切顶往下拉，就能看到被挡住的地面。

---

## 它能给你什么

- **带朝向的包围盒**，不只是一个点。在底图上拖角点调宽、深、朝向，高度手填。
- **双语标签。** 每个物体在每次导出里都同时带英文名和中文名，来自类别预设。
  界面一个按钮切换语言，并且记住选择。
- **类别预设是 JSON。** 内置两套（`generic`、`operating-room`）；
  第三套就是你自己写一个文件，用 `--classes` 传进来。
- **参考位置是可选的。** 用 `--targets` 传一份已有的真值，每个位置会画成一个圈，
  你可以确认、修正、或者标注「此处无物」。这正是它被造出来要干的活：
  不是「推车在哪」，而是「推车是不是在文件说的那个地方」。
- **带名字的地面路线**，想画几条画几条，各有各的颜色和长度。
- **标注随时存在浏览器里**，键的设计使得：参考位置变了就给你一块干净的画布，
  而路线不会因为重建而丢失。

## 它不做什么

- **它不做任何自动分割。** 它按设计就是一个手动标定器。如果你的网格是摄影测量
  外壳 —— 整个房间蒙一层焊死的连续曲面 —— 没有任何聚类方法能把推车和它背后的
  墙分开，而这正是本工具被写出来所面对的处境。
- **它不测量高度。** 盒子的高度是类别默认值，你可以改。你拖出来的宽、深、朝向
  是你的；高度是标称值，导出里也不会假装不是。
- **一个场景、一个人、一个浏览器。** 没有服务端状态，没有账号。

---

## 安装

meshmark 本身**没有 Python 依赖**。它需要一份 three.js 放进构建出来的包里，
按下列顺序寻找：

1. `--three /path/to/node_modules/three`
2. `$MESHMARK_THREE`
3. `./node_modules/three`、`~/node_modules/three`

```bash
npm install three          # 装在本目录就够了
pip install -e .
```

## 用法

```bash
# 空房间，通用类别，英文界面
meshmark build scan.glb --out .annotate/room

# 手术室，中文界面，对照已有真值，并把机器人起始位姿画成固定参考点
meshmark build or_room.glb --out .annotate/or_room \
    --scene or_room \
    --classes operating-room \
    --lang zh \
    --targets gt_or_room.json \
    --reference "robot_start=-1.35,-1.9"

meshmark serve .annotate/or_room --open
```

`serve` 只绑定 `127.0.0.1`。一个包里带着它所指向的那份网格的副本，
而对一个真实房间的扫描来说，把它挂到监听端口上不应该是个意外。

### 输入格式

| 格式 | 说明 |
|---|---|
| `.glb` | 单文件，贴图内嵌。最省事的情况。 |
| `.gltf` | 它的 buffer 和 image 会被找出来一起放进包里。 |
| `.obj` | 它的 `.mtl` 以及 `.mtl` 里点名的每一张贴图都会跟着走，目录结构原样保留。 |

大扫描：`--link` 用符号链接代替复制。

### 操作

| | |
|---|---|
| 3D | 左键拖旋转 · 右键拖平移 · 滚轮缩放 · **单击**放置 |
| 俯视 | 单击设中心 · 框内拖移动 · 拖角点改尺寸 |
| 键盘 | 方向键 1 cm（Shift 10 cm）· Enter 下一个 · F 回到目标 · Del 删除 |

---

## 输出

```json
{
  "format": "meshmark/annotations",
  "version": 1,
  "scene": "or_room",
  "source": {
    "mesh": "or_room.glb",
    "floor_z_m": 0.1079,
    "floor_source": "measured from the mesh",
    "plate": { "pixels": 2048, "metres_per_pixel": 0.00333, "centre_xy": [0, 0] }
  },
  "objects": [
    {
      "object_id": "or_room_cart_001",
      "class_id": "cart",
      "label": "cart",
      "label_zh": "推车",
      "kind": "reference",
      "status": "corrected",
      "reference_xy": [-0.59, 1.18],
      "world_xy": [-0.7691, 1.2038],
      "footprint": { "width_m": 0.851, "depth_m": 0.481,
                     "height_m": 1.45, "yaw_deg": -69 },
      "offset_m": 0.1834,
      "note": ""
    }
  ],
  "routes": [
    { "id": "route_1", "name": "路径 1",
      "waypoints": [[-1.0, -2.0], [0.0, -1.0]], "length_m": 1.414 }
  ]
}
```

`status` 取 `pending`、`confirmed`、`corrected`、`absent`、`added` 之一。

你的 `--targets` 文件里 meshmark 不理解的字段，会原样放在 `source_fields` 里还给你，
所以一趟标定下来不会丢任何东西。

### 参考文件

`--targets` 读字段名的时候是宽松的，因为每个项目的拼法都不一样：
`object_id` / `id` / `name` 任选，`world_xy` / `xy` / `position` / `world_xyz` 任选，
`footprint_radius_m` / `radius_m` 任选。但它**不会**默默放过的是：
一个解析下来没有任何可用位置的文件是错误；重复的 id 也是 ——
id 是你保存工作的键，两个目标共用一个会互相覆盖对方的标注。

### 类别预设

```json
{
  "name": "warehouse",
  "display": { "en": "Warehouse", "zh": "仓库" },
  "classes": [
    { "id": "pallet", "en": "pallet", "zh": "托盘", "size_m": [1.2, 0.8, 0.15] }
  ]
}
```

两种语言都是必填的。少一个 `zh` 会直接构建失败，而不是悄悄回退到英文 ——
一个看起来翻译过、实际没翻译的界面，比一个拒绝构建的工具更糟。

尺寸是标称值，作用是让放置一个物体只需点一下，而不是点一下再填三个数字。
每个框都应该拖到贴合为止。

---

## 两件被验证过、而不是被假定的事

**地面是找出来的，不是假定在 z=0 的。** meshmark 取最低一米几何里面积最大的
水平层，按**面积**加权而不是按三角形个数 —— 一张精细剖分的桌面，三角形数量
远多于一块粗糙的地板。本工具面对的两个房间地面分别在 108 mm 和 171 mm，
两者都加载在原点；一个能避开其中一个地面的绝对切高，会切进另一个，
而由此产生的误差看起来像「这个物体怎么有点矮」，不像一个 bug。
如果你更清楚，用 `--floor` 覆盖它。

**底图的映射在启动时用探针核对过。** 一个翻转的坐标轴产生的标注看起来完全合理，
而且是镜像的 —— 这种错没人靠肉眼审查能发现。加载时 meshmark 会在一个已知的
非对称位置渲染一个标记，检查它是否落在映射预测的像素上，然后把误差打出来：

```
meshmark: plate mapping verified to 0.89 px (3.0 mm)
```

对不上就是一条 console error，而不是一次沉默的成功。

---

## 测试

```bash
python -m pytest          # 包含 JavaScript，通过 node 跑
npm test                  # 只跑 JavaScript
```

JavaScript 放在 `.js` 文件里而不是塞在一个 Python 字符串里，这不是洁癖。
本工具脱胎于另一个工具，那个工具整整 900 行的应用逻辑就是一个 Python 文件里的
字符串字面量 —— 于是「一行里删掉的标识符、另一行里还在读」这种错，
对解释器、对 linter、对测试全部不可见。这样的错真的发生过一次：
它让恢复已保存工作的代码失效，而页面照旧承诺着「刷新不丢」，
实际上每次加载都把所有标注丢掉。`tests/js/store.test.mjs` 的第一个测试，
就是它再发生一次时会失败的那个。

## 许可

MIT —— 见 [LICENSE](LICENSE)，构建产物包含什么见 [NOTICE](NOTICE)。

你构建出来的包里包含一份 three.js（同为 MIT），取自你自己的安装；
本仓库不再分发 three.js。
