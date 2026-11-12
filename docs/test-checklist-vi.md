# Checklist test tay (tiếng Việt)

Checklist này dành cho An. Làm theo từng mục để test các tính năng đã merge trong hai ngày gần đây.
Mỗi mục có ba phần: mở gì, nhìn gì, đạt hay trượt.
Các recipe nằm ở cuối file (A1 đến A9). Mỗi recipe đã chạy qua `scene_create` và `scene_look` trên RTX 3060 (backend `gpu`) và ra PNG.

## Bắt đầu

1. Chạy MCP server từ [README](https://github.com/codepawl/67.js#readme): `npx 67js-mcp --backend gpu --memory 192`. Thêm `--assets <đường dẫn tuyệt đối tới thư mục>` cho các mục có GLB hoặc PNG. Cấu hình client nằm trong [MCP reference](https://67js.codepawl.com/mcp.md).
2. Chạy site local: `npm run dev`, rồi mở `http://127.0.0.1:5173/`. Cổng 5173 là cổng mặc định của Vite, và Vite đổi cổng nếu bị chiếm.
3. Site live nằm ở `https://67js.codepawl.com/`. Mở `https://67js.codepawl.com/release.json` và so trường `commit` với commit mới nhất của `main`. Nếu thấy bản cũ, bấm Ctrl+Shift+R. Nếu vẫn cũ, mở DevTools, vào Application, Storage, bấm Clear site data, rồi tải lại.
4. Tạo thư mục asset cho các mục 6, 7, 8 và 9. Chạy ở thư mục gốc của repo:

   ```powershell
   New-Item -ItemType Directory -Force artifacts/test-assets
   Copy-Item tests/fixtures/RobotExpressive.glb artifacts/test-assets/
   node -e "import('./tests/fixtures/car-glb.js').then(m=>require('fs').writeFileSync('artifacts/test-assets/car.glb',Buffer.from(m.carAsset())))"
   node -e "const s=require('sharp');['red','lime','blue'].forEach((c,i)=>s({create:{width:64,height:64,channels:3,background:c}}).png().toFile('artifacts/test-assets/frame-'+i+'.png'))"
   ```

   Chạy server với `--assets` trỏ tới `artifacts/test-assets`. Gọi `scene_asset_catalog` để lấy id của từng file. Thay các `<id ...>` trong recipe bằng id đó.
5. Prompt mẫu cho Claude Code: `Đọc recipe A1 trong docs/test-checklist-vi.md, gọi scene_create với recipe đó, rồi scene_look 960x540 và mô tả ảnh.`
6. Server giữ một cảnh mỗi lần. Gọi `scene_dispose` trước khi `scene_create` recipe tiếp theo. `scene_render_submit` cần `expectedRevision`, lấy từ `revision` mà `scene_create` trả về (là 0 với cảnh vừa tạo).

## 1. Bóng và khúc xạ của nước (#363)

- Mở: recipe A1 qua MCP (prompt mẫu ở trên).
- Nhìn: phần cột chìm dưới nước nhạt dần về màu nước, và bóng cột in lên đáy hồ. Bóng trên mặt nước chỉ mờ nhẹ, không làm tối phản chiếu.
- Đạt: thấy cả ba điều trên. Trượt: cột chìm vẫn nguyên màu như phần trên mặt nước, hoặc không có bóng ở đáy.

## 2. Phản chiếu nước nhám (#372)

- Mở: `https://67js.codepawl.com/showcase.html?scene=port`. Cảnh Container port có mặt nước (`waterReflection: true`) và tải mất khoảng 30 giây. Đợi tới khi hết dòng "Loading", rồi kéo chuột để xoay camera.
- Nhìn: mặt biển sau con tàu, ngay dưới đường bờ, có dải phản chiếu sáng ấm và hơi nhòe của bờ và trời.
- Đạt: còn phản chiếu mờ. Trượt: mặt nước chỉ còn màu phẳng của môi trường.
- Chạy thêm `node --test tests/water-reflection.test.js` để kiểm tra phần tính độ nhòe.

## 3. Ánh sáng bù ngoài trời (#366)

- Mở: recipe A2 qua MCP. Mặt trời thấp, camera nhìn vào phía khuất nắng của tường và khối hộp.
- Nhìn: mặt khuất nắng còn thấy chi tiết, không đen đặc.
- Đạt: mặt khuất nắng xám sáng. Trượt: mặt khuất nắng đen gần hoàn toàn.
- (chưa kiểm được so sánh trước và sau: MCP không có công tắc `outdoorFill`.) Số đo của PR nằm trong `docs/lighting.md`: p20 của `mountain-valley` tăng từ 0.60 lên 0.79. Chạy `node --test tests/ground-bounce.test.js` để kiểm tra phần tính toán.

## 4. Subsurface scattering (#364, #376, #379)

- Mở: recipe A3 qua MCP. Rồi gọi `scene_render_submit` với `settings` `{"kind":"image","width":320,"height":180,"renderer":{"type":"pathTracer","samples":16,"bounces":4,"maxSeconds":90}}`.
- Nhìn: quả cầu trái có `subsurface` (weight 1), quả phải không có. Nhìn phía tối của hai quả.
- Đạt: quả trái có dải hồng mềm ở phía tối, quả phải xám trơn. Job path tracer báo `completed`. Trượt: hai quả giống nhau, hoặc job báo `failed`.

## 5. Cây trong recipe (#361, #382)

- Mở: recipe A4 qua MCP, rồi gọi `scene_inspect`.
- Nhìn: `vegetation` báo 99 cây (42 broadleaf, 30 bush, 27 conifer) và mỗi loài có mảng `levels`. Lá chuyển màu cam vì `season` 0.6.
- Đạt: số cây khớp và ảnh có rừng trên đồi. Trượt: số cây khác với cùng `seed`, hoặc ảnh không có cây.
- Impostor (#382) chỉ có trong code. Chạy `node --test tests/vegetation-impostors.test.js`. Đạt khi 11 test pass.

## 6. Đám đông (#383)

- Mở: recipe A5 qua MCP (cần id của `RobotExpressive.glb`), rồi gọi `scene_inspect`.
- Nhìn: mục `assets` có `kind: "crowd"`, `instances` 60, `batches` 3, `lods: true`, và `farPose` với `distance` 12, `rate` 6.
- Đạt: số liệu khớp và ảnh có 60 robot. Trượt: `scene_create` báo lỗi, hoặc `batches` bằng 60.

## 7. Xe chạy (#360)

- Mở: recipe A7 qua MCP (cần id của `car.glb`). Gọi `scene_look` với `motionTime` 0, rồi 1.5.
- Nhìn: `scene_inspect` có `drive` với 4 bánh (`front-left`, `front-right`, `rear-left`, `rear-right`), bán kính 0.35 m. Xe ở chỗ khác giữa hai ảnh: lúc 0 xe ở gần đáy khung, lúc 1.5 xe đã chạy lên giữa khung.
- Đạt: nhận ra 4 bánh và hai ảnh khác nhau. Trượt: `wheels` rỗng, hoặc xe đứng yên.

## 8. Asset từ catalog trong recipe và render job (#336, #375)

- Mở: recipe A6 qua MCP (cần id của `RobotExpressive.glb`). Rồi gọi `scene_render_submit` với `settings` `{"kind":"image","width":480,"height":270,"motion":{"start":1}}`.
- Nhìn: `scene_inspect` liệt kê `assets` với hai placement (`robot-a`, `robot-b`). Job trả file `render.png`.
- Đạt: job báo `completed` và ảnh có hai robot trên đồi. Trượt: job báo `failed`, hoặc ảnh thiếu robot.

## 9. Chuỗi texture (#377)

- Mở: recipe A8 qua MCP (cần id của ba file `frame-*.png`). Gọi `scene_look` với `motionTime` 0, 0.1 và 0.2.
- Nhìn: màn hình đổi từ đỏ sang xanh lá rồi xanh dương. `scene_inspect` có `textureSequences` với `frames` 3 và `fps` 10.
- Đạt: ba ảnh có ba màu khác nhau. Trượt: cả ba cùng một màu.

## 10. Reversed-Z depth (#370)

- Mở: chạy `node bench/reference/depth-precision.mjs gpu` (cần Chrome). Rồi chạy recipe A9 qua MCP và gọi `scene_inspect`.
- Nhìn: trong JSON, ở `distance` 50 và `gapMillimetres` 0.1, `farWinsMean` của `before` khoảng 0.15 và của `after` khoảng 0.009. `scene_inspect` của A9 có cảnh báo `coplanar-overlap`.
- Đạt: `after` nhỏ hơn 0.02 ở 50 m, và có cảnh báo cho cặp `paint` với `floor`. Trượt: `after` bằng `before`, hoặc không có cảnh báo.

## 11. GlTF fallback (#381)

- Mở: chạy `node --test tests/gltf-sketchfab-fallbacks.test.js`.
- Nhìn: test báo pass. Nạp một GLB dùng `KHR_materials_pbrSpecularGlossiness` bằng `scene_create_asset` thì `warnings` có dòng "converted to metallic-roughness".
- Đạt: file nạp được, có warning và không báo lỗi. Trượt: nạp file bị throw.

## 12. Depth MSAA 24 bit (#387)

- Mở: `https://67js.codepawl.com/object.html`, hoặc `http://127.0.0.1:5173/object.html` khi chạy local. Mở Console và chạy `__studio.renderer.renderTargets.report()`.
- Nhìn: trong `targets`, mục `multisampleDepth` có `format` `DEPTH_COMPONENT24` và `samples` 4.
- Đạt: thấy `DEPTH_COMPONENT24` và ảnh bình thường. Trượt: `multisampleDepth` dùng `DEPTH_COMPONENT16`.

## Recipe

Dán nguyên JSON vào `scene_create`. Id asset là placeholder, thay bằng id từ `scene_asset_catalog`.

### A1

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"cube","type":"box","bevel":0,"subdivisions":1}],"materials":[{"id":"bed","color":[0.55,0.45,0.3],"roughness":0.9},{"id":"post","color":[0.85,0.85,0.9],"roughness":0.6},{"id":"water","tag":"water","waterPreset":"lake","color":[0.1,0.3,0.4],"roughness":0.02,"opacity":0.7}],"nodes":[{"id":"bed","geometry":"cube","material":"bed","translation":[0,-2.1,0],"scale":[30,0.2,30]},{"id":"post","geometry":"cube","material":"post","translation":[0,-0.2,0],"scale":[0.5,3.6,0.5]},{"id":"water","geometry":"cube","material":"water","scale":[30,0.05,30]}],"camera":{"eye":[6,3,6],"target":[0,-0.8,0],"fov":40}}
```

### A2

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"cube","type":"box","bevel":0,"subdivisions":1}],"materials":[{"id":"ground","color":[0.45,0.4,0.33],"roughness":0.9},{"id":"wall","color":[0.7,0.68,0.62],"roughness":0.8}],"nodes":[{"id":"ground","geometry":"cube","material":"ground","translation":[0,-0.1,0],"scale":[60,0.2,60]},{"id":"wall","geometry":"cube","material":"wall","translation":[0,2,0],"scale":[6,4,0.6]},{"id":"block","geometry":"cube","material":"wall","translation":[-5,1,3],"scale":[2,2,2]}],"environment":{"lightDirection":[0.9,0.12,0.3]},"camera":{"eye":[-10,3,-12],"target":[0,1.5,0],"fov":45}}
```

### A3

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"cube","type":"box","bevel":0,"subdivisions":1},{"id":"ball","type":"sphere","segments":48,"rings":32}],"materials":[{"id":"floor","color":[0.5,0.5,0.5],"roughness":0.9},{"id":"skin-on","color":[0.8,0.5,0.4],"roughness":0.5,"subsurface":{"weight":1,"radius":[1,0.3,0.15],"scale":0.5}},{"id":"skin-off","color":[0.8,0.5,0.4],"roughness":0.5}],"nodes":[{"id":"floor","geometry":"cube","material":"floor","translation":[0,-0.05,0],"scale":[12,0.1,8]},{"id":"ball-on","geometry":"ball","material":"skin-on","translation":[-1.4,1,0],"scale":[1,1,1]},{"id":"ball-off","geometry":"ball","material":"skin-off","translation":[1.4,1,0],"scale":[1,1,1]}],"environment":{"lightDirection":[-0.5,0.55,-0.7]},"camera":{"eye":[0,2.2,7],"target":[0,0.9,0],"fov":40}}
```

### A4

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"hills","type":"terrain","size":80,"resolution":64,"seed":3,"amplitude":2}],"materials":[{"id":"soil","color":[0.3,0.38,0.2],"roughness":0.95}],"nodes":[{"id":"ground","geometry":"hills","material":"soil"},{"id":"forest","vegetation":{"mix":{"broadleaf":3,"conifer":2,"bush":2},"seed":11,"season":0.6,"scatter":{"ground":"ground","density":0.014,"slopeLimit":30}}}],"environment":{"wind":{"strength":0.5,"direction":0}},"camera":{"eye":[0,4,38],"target":[0,3,0],"fov":50,"far":400}}
```

### A5

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"cube","type":"box","bevel":0,"subdivisions":1}],"materials":[{"id":"ground","color":[0.4,0.42,0.38],"roughness":0.9}],"nodes":[{"id":"ground","geometry":"cube","material":"ground","translation":[0,-0.05,0],"scale":[60,0.1,60]},{"id":"people","asset":{"id":"<id của RobotExpressive.glb>","crowd":{"clip":10,"count":60,"seed":7,"spacing":2,"farDistance":12,"farRate":6}}}],"camera":{"eye":[0,7,16],"target":[0,1,0],"fov":50}}
```

### A6

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"cube","type":"box","bevel":0,"subdivisions":1},{"id":"hills","type":"terrain","size":30,"resolution":32,"seed":2,"amplitude":0.5}],"materials":[{"id":"soil","color":[0.35,0.4,0.25],"roughness":0.95}],"nodes":[{"id":"ground","geometry":"hills","material":"soil"},{"id":"robot-a","translation":[-1.5,0,0],"asset":{"id":"<id của RobotExpressive.glb>","clip":{"index":0,"start":0,"loop":true}}},{"id":"robot-b","translation":[1.5,0,0],"asset":{"id":"<id của RobotExpressive.glb>","materials":[{"name":"Main","color":[0.9,0.2,0.1]}]}}],"camera":{"eye":[0,2.5,8],"target":[0,1,0],"fov":45}}
```

### A7

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"cube","type":"box","bevel":0,"subdivisions":1}],"materials":[{"id":"road","color":[0.2,0.2,0.22],"roughness":0.9}],"nodes":[{"id":"road","geometry":"cube","material":"road","translation":[8,-0.05,12],"scale":[40,0.1,40]},{"id":"car","asset":{"id":"<id của car.glb>","drive":{"path":[[0,0,0],[0,0,12],[6,0,22],[16,0,26]],"cruiseSpeed":8}}}],"camera":{"eye":[-10,16,-10],"target":[6,0,13],"fov":50}}
```

### A8

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"plane","type":"grid","segments":1}],"materials":[{"id":"screen","doubleSided":true,"map":{"sequence":{"frames":["<id frame-0.png>","<id frame-1.png>","<id frame-2.png>"],"fps":10}}}],"nodes":[{"id":"screen","geometry":"plane","material":"screen","scale":[4,3,1]}],"camera":{"eye":[0,0,6],"target":[0,0,0],"fov":40}}
```

### A9

```json
{"format":"67js.scene","schemaVersion":1,"geometries":[{"id":"cube","type":"box","bevel":0,"subdivisions":1}],"materials":[{"id":"floor","color":[0.8,0.2,0.2]},{"id":"paint","color":[0.2,0.2,0.8]}],"nodes":[{"id":"floor","geometry":"cube","material":"floor","translation":[0,-0.05,0],"scale":[40,0.1,40]},{"id":"paint","geometry":"cube","material":"paint","translation":[0,-0.05,0],"scale":[10,0.1,10]}],"camera":{"eye":[0,3,60],"target":[0,0,0],"fov":40,"far":500}}
```
