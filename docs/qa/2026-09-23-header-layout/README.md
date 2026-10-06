# 2026-09-23 顶部导航居中验证

登录后的顶部导航曾使用不对称网格列，使 tab 向右侧偏移。现统一使用左右等宽、中间自适应的三列布局，tab 相对整个页面居中；921–1100px 下略缩小右侧控件间距以避免碰撞。

- 游客、需求方、能力方分别检查 1440、1280、1101、1100、921px：导航中心与页面中心偏差不超过 1px；导航与 logo、右侧操作区净间距至少 8px，无横向溢出，链接保持单行。
- 390px 手机菜单按身份显示入口，开关及键盘焦点恢复正常；已有双身份回归另覆盖 320px、切换与数据隔离。
- 3 项布局回归及 6 项双身份回归全部通过；浏览器未出现未捕获脚本异常。
- `npm run check`、E2E TypeScript 检查和 `git diff --check` 通过。测试在本地隔离 API、数据库和合成账户上执行；尚未部署线上。

已查看截图：[桌面 1440px](header-1440.png)、[窄桌面 921px](header-921.png)、[手机菜单 390px](header-390.png)。

复现命令：

```sh
E2E_WEB_PORT=5199 npm run test:e2e -- apps/web/e2e/header-layout.spec.ts apps/web/e2e/dual-role.spec.ts
npx tsc --noEmit --project apps/web/e2e/tsconfig.json
```
