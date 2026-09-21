import { readValidatedPnvsCredential } from "./pnvsCredentialPrompt.js";
import { preparePnvsCredentialDestination, savePnvsCredentials } from "./pnvsCredentials.js";

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length > 2) {
    process.stderr.write("请在交互式终端运行 npm run auth:configure:pnvs；不要通过参数、管道或聊天传递密钥。\n");
    process.exitCode = 1;
    return;
  }
  let file: string;
  try {
    file = preparePnvsCredentialDestination();
  } catch {
    process.stderr.write("尚未开始录入：私有保存位置不可用，或已有 pnvs.json 配置。请先检查文件是否存在及目录权限；不要删除或覆盖原配置。\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("DuduHire 短信认证密钥安全录入\n");
  process.stdout.write("仅录入 duduhire-auth-dev 的 AccessKey，不要使用主账号或 Qwen 密钥。\n");
  process.stdout.write("两个输入均不回显；每次只粘贴对应的一项，按 Enter 继续；Ctrl+C 取消。\n");
  process.stdout.write("请等对应输入提示出现后再粘贴；若粘贴后已自动进入下一项，不要再按 Enter。\n");
  const accessKeyId = await readValidatedPnvsCredential("AccessKey ID");
  const accessKeySecret = await readValidatedPnvsCredential("AccessKey Secret");
  try {
    savePnvsCredentials({ accessKeyId, accessKeySecret });
  } catch {
    process.stderr.write("两项输入已通过本地格式检查，但文件保存失败。已有配置不会被覆盖。请检查目录权限、磁盘状态或是否有另一录入程序已保存；不要发送密钥。\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`已保存到 ${file}（目录 0700 / 文件 0600）。\n`);
  process.stdout.write("未发送短信，也未验证密钥有效性。本地 API 开发模式可安全读取此文件；真实发送默认关闭，需获批准的测试号码和发送限额后再联调。\n");
}

void main().catch(() => {
  process.stderr.write("录入已中断，尚未完成保存。请保持终端打开后重新运行；Ctrl+C 或关闭输入会取消录入。密钥不会输出。\n");
  process.exitCode = 1;
});
