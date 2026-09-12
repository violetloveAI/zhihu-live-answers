# 活答案 · 好奇心俱乐部

和刘看山一起，沿着经历、依据与下一问，让答案继续生长。

**[打开在线演示](https://violetloveai.github.io/zhihu-live-answers/)** · [图文功能手册](https://violetloveai.github.io/zhihu-live-answers/manual/index.html) · [PDF 手册](https://violetloveai.github.io/zhihu-live-answers/manual/manual.pdf)

这是知乎黑客松作品的报名交互演示。它用虚构教学样例展示贡献、追问和答案修订的完整过程；演示整理结果由本地规则生成，不代表真实模型输出或真实知乎用户观点。

![在线演示首页](preview/home.png)

## 可以体验什么

| 页面 | 用途 |
| --- | --- |
| 答案广场 | 阅读当前答案、适用条件、支持与反例，检查来源和旧版本 |
| 我的经历 | 查看自己的贡献，按类型检索，检查关联结果，撤回或删除贡献 |
| 看山的小本子 | 查看待验证问题、待审修订、下一问及答案成长记录 |

![我的经历：个人贡献档案](preview/experiences.png)
![看山的小本子：问题与修订工作台](preview/notebook.png)

体验从右上角“加入我们”开始，选择“和看山体验完整流程”，进入演示维护者空间。页面已准备两个议题、四份虚构个人贡献、待确认问题和样例修订。

- 写一段经历，选择昵称、匿名或化名，核对公开预览后提交。
- 检查看山给出的关联及依据；贡献不会直接覆盖当前答案。
- 确认一条下一问，在本站演示讨论中回复。
- 审阅修订的原文、建议和证据，确认采纳后查看版本历史。
- 退出当前体验，再选择“以经验贡献者身份体验”，查看普通参与者可用的功能。

## 在线版本的范围

所有记录只保存在当前浏览器的 `localStorage` 中。刷新页面会保留当前体验；清除网站数据会重置。不同浏览器和设备之间不共享记录，退出后重新选择身份会创建新演示空间。演示角色用于展示界面流程，不是真实账号权限。

GitHub Pages 托管的是浏览器应用，没有运行数据库、账号服务器或后台任务。在线版不连接知乎 OAuth、真实模型、真实搜索或外部发布接口；来源发现、内容关联和修订均为明确标注的规则演示。请使用虚构资料体验，不要提交敏感信息。

PDF 和图文手册中的截图来自本地完整版本，手册另列在线版本的存储及接入范围。该演示不承诺跨设备同步、多人协作或真实社区回写。

## 本地运行与更新

需要 Node.js 24 和 npm。仓库根目录是已编译、可直接托管的网页，`source/` 保存用于复现的 Next.js 源码。

```bash
git clone https://github.com/violetloveAI/zhihu-live-answers.git
cd zhihu-live-answers/source
npm ci
npm run dev
```

打开 `http://127.0.0.1:4173/zhihu-live-answers/`。无需配置密钥或环境文件。

修改 `source/` 后，从仓库根目录重新构建：

```bash
npm --prefix source run typecheck
npm --prefix source run build
node scripts/update-pages.mjs
```

构建成功后，提交更新的源码与生成文件。GitHub Pages 使用 `main` 分支根目录，`.nojekyll` 使 `_next` 资源直接提供给浏览器。项目固定使用 `/zhihu-live-answers` 路径，内页刷新可直接打开。

## 实现与素材

界面使用 Next.js、React、TypeScript 和 Lucide 图标。原始全栈实现来自 [Fei-Good/zhihu-live-answers](https://github.com/Fei-Good/zhihu-live-answers)。`source/` 包含界面、浏览器演示实现、共享数据类型和部分原始服务端业务代码；保留的服务端代码不会在 GitHub Pages 上运行。部署包不包含 API 路由、环境文件或运行凭据。

刘看山形象来自[知乎黑客松参赛手册](https://my.feishu.cn/docx/Mc80dR5XvoPaYDxcTasc04POnjd)提供的官方比赛素材。相关 IP 属于知乎，赛事授权不等同于第三方商用或素材再授权。本仓库没有另行授予这些素材开源许可。
