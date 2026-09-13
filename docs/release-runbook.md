# Desktop release runbook

## Local Windows UKey signing runner

Windows packaging and signing run as separate jobs. The GitHub-hosted Windows runner builds an unsigned NSIS installer and uploads a short-lived workflow artifact. A local macOS ARM64 runner downloads it, signs the installer with Jsign and the SafeNet UKey, regenerates the blockmap and `latest.yml`, and uploads the signed release set. The GitHub Release job cannot start unless signing succeeds.

Prepare the local runner once:

1. Register it with the `self-hosted`, `macOS`, and `ARM64` labels.
2. Install SafeNet Authentication Client and confirm `/usr/local/lib/libeTPkcs11.dylib` is readable.
3. Connect the UKey before pushing a release tag.
4. In the GitHub repository, open **Settings → Secrets and variables → Actions** and create a repository secret named `DESKTOP_WINDOWS_SIGNING_PIN` containing the UKey PIN. For stronger release controls, use an environment secret and add the matching `environment` to the `sign-windows` job.
5. Restrict release tag creation and workflow changes to trusted maintainers. A self-hosted runner can access any secret injected into its job.

The workflow pins Jsign 7.5 by SHA-256 and uses the SafeNet `ETOKEN` store, SHA-256 signing, and a DigiCert RFC 3161 timestamp. GitHub injects the PIN only into the signing step. The step copies it to a mode-`600` temporary file, removes it from the shell environment, and deletes the file when the step exits. The workflow never prints the PIN or passes it as a command-line argument.

After a tag release succeeds, verify that the Windows installer shows the expected publisher and a valid RFC 3161 timestamp in its Digital Signatures properties. Never reuse a published tag; fix the issue and release a new version.

## 选择稳定历史版本

GitHub Actions → **Manage stable release history** → **Run workflow**，使用包含本机制的 `main` 分支：

- `tag`：已有 GitHub Release 的完整标签，例如 `v0.8.2`。请填写已经完成实机验证、适合长期回退的版本。
- `stable_history = retain`：归档该版本并标记为“稳定历史版”。可以重复操作，保留多个版本。
- `stable_history = unpin`：取消该版本的稳定标记，安装包和普通历史记录仍保留。
- `stable_history = keep`：仅回填归档，不改变已有稳定标记。

此操作下载已有 Release 的原始资产，验证两个 macOS 架构和 Windows 的完整安装包、更新元数据及校验和，不重新打包。已有归档不重写；同版本元数据不同会失败，需核实原始资产，不能用新包覆盖旧版本。

稳定选择记录在 ModelScope `releases/versions.json` 对应版本的 `stableHistory: true` 中。每次正式发版合并旧目录和新版本，保留所有历史记录及稳定标记。新版本不会自动成为稳定历史版。客户端“关于 → 历史版本（回退）”会优先显示稳定历史版并标注文案；这些版本不受普通版本最近 12 项的展示上限影响。旧客户端仍能读取同一索引，但没有新标记和优先显示。

历史管理操作只修改归档与历史索引，不更改 `releases/latest` 或灰度更新规则，也不触发用户自动降级。

## 历史发布保护与恢复

正式发布和历史管理共用 `desktop-version-catalog` 并发组，串行更新目录。发布脚本直接读取 ModelScope 的历史索引，读取失败、404 或内容损坏均终止，不再用“仅当前版本”的索引覆盖历史。新版本先归档，再写历史索引，最后更新 latest。

如果历史索引此前已经丢失条目，在上述工作流中按旧 Release 标签逐个回填；选择 `retain` 可同时确定稳定历史版。无需再次发布当前版本。脚本不会猜测哪个旧版本稳定，本次机制也没有默认指定版本。

如历史索引本身不可读取，先恢复 ModelScope 中原有 `releases/versions.json` 再重试。如归档仅存在一个平台的元数据，流程会拒绝继续，需先核实并恢复该版本的完整原始归档。请勿用空索引绕过错误。

发布后检查 `https://dshdesktop.com/updates/versions.json`：旧版本仍存在，选定版本含 `stableHistory: true`，且 `/updates/archive/<version>/latest.yml` 和 `latest-mac.yml` 指向对应版本。客户端展示和实际下载安装需在发布后另外验收。
