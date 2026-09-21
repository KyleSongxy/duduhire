# kylesong.top 切换后的浏览器验收

本清单对应 `duduhire-20260912-native-3` 与经过真实 Nginx 副本审查的候选配置。以下项目尚未执行；本地候选、模拟 Nginx 测试和 API 200 均不代表这些项目已经通过。只使用本次已获准的测试账号、号码与发送次数，验证码由用户在原页面私下输入。

## 域名、同源 API 与静态资源

- 打开 `https://kylesong.top/`，确认显示新版 DuduHire；检查 HTML 实际加载 `index-Bno7PqwM.js`，直接刷新 `/how-it-works`、`/signup` 与 `/login` 均正常。
- 打开 `https://www.kylesong.top/signup?method=phone`，确认跳到 `https://kylesong.top/signup?method=phone`，路径与查询保留；认证 POST 的 Origin 必须为规范主域。
- 确认 HTTPS 证书有效，浏览器无混合内容、CSP 或 MIME 阻断。请求 `/api/health/ready` 返回 JSON `{"status":"ready"}`，`/api/v1/auth/methods` 返回 JSON 而非 SPA HTML。业务请求使用主域 `/api/v1`，不依赖 API 子域跨域 Cookie。
- 查看首页图片、工作方式示意图与 `/fonts/duduhire-sans.woff2` 实际加载成功；当前产品图片、字体和影片均使用同源路径，不需要新增 CSP 外部域。

## 影片、布局与语音输入

- 桌面和手机宽度分别检查首页与 `/how-it-works`：没有横向溢出、表单重叠或不可见按钮；保留正常键盘焦点和点击目标。
- 首页 `/images/home-hero-team-kling.mp4` 正常显示画面并按浏览器规则静音播放；工作方式 `/images/how-it-works-product-motion-v2-4k.mp4` 可以手动播放、暂停、拖动并播至结束。确认 `video/mp4`、正常字节范围响应和实际画面清晰度；海报或 HTTP 200 不能代替播放。
- 开启减少动态效果偏好后重新加载，确认页面保留产品原有的自动播放限制及手动播放能力；移动浏览器仍能内联控制影片。
- 主域响应的 Permissions-Policy 应仅把 microphone 改为 `(self)`，camera/geolocation 仍为 `()`；API 子域保持原策略。支持 SpeechRecognition 的浏览器中，由用户主动点语音输入并正常授权，确认文字能填入、结束收音有效；不支持或拒绝授权时保留键盘输入与准确反馈，不绕过浏览器权限。

## 认证与真实服务边界

- 若 `EMAIL_DELIVERY_MODE=disabled`：methods 显示 `email.available=false`、`delivery=disabled`；页面显示邮箱未启用，在短信可用时默认选短信。邮件发送与旧链接核验返回 `503 EMAIL_AUTH_DISABLED`，没有“已发送”提示或新会话；两项都未启用时禁止发送，不引导用户改用另一项不可用服务。
- 若邮件设为 `smtp`：实际收到邮件后，在发起申请的同一浏览器打开链接，确认账户、刷新会话、退出与再次登录；异浏览器和复用旧链接被拒绝。仅 SMTP 接受不算真实送达。
- 短信仅用明确允许的测试号码：一次申请后确认手机实际收件，用户私下输入验证码；确认注册、刷新会话、退出/再次登录与错误/旧验证码拒绝。发送超时不自动重发；白名单外号码仍拒绝，不能写成已经开放公众短信注册。
- 使用获准的合成内容完成一条真实 Qwen 梳理，确认页面收到服务端结果并能刷新恢复；不把本地规则或预置示例当成真实模型成功。

## 旧 service worker

- 在确实曾安装旧站 worker 的浏览器中执行验收。确认 `/service-worker.js` 返回真实 JavaScript、正确 MIME 和 `Cache-Control: no-cache`，没有落入 HTML 回退。
- 确认旧注册更新/激活后清理 `fangxu-shell-v2`、保留无关缓存并解除注册；刷新原来受控的标签页后进入新版，页面和 API 请求不再被旧 worker 缓存处理。
- 新浏览器无旧缓存只能证明新访问路径正常；VM 生命周期测试或手动删除缓存不能替代旧客户端更新验收。

## 记录与回滚

记录版本、候选配置 SHA-256、时间、测试设备/浏览器、各项结果和未完成原因。截图、网络记录和说明不保留 OTP、Magic Link、Cookie、凭据或个人联系方式。邮件停用应明确填写“停用行为通过，邮件投递与登录未启用”。

发现新站认证、核心页面或旧客户端升级回归时，保留错误证据并按本次备份恢复旧 Nginx root/upstream；不要删除旧站、新库或篡改数据库迁移记录。切换脚本的自动回滚仅覆盖配置测试/reload 失败，不能代替上述浏览器验收后的判断。
