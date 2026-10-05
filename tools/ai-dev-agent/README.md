# AI Dev Agent

Tiến trình Node chạy độc lập (không nằm trong API server). Agent đọc log của bot, phân tích hành vi bằng một **LLM local tương thích OpenAI**, ghi nhớ kết quả các lần chạy trước, đề xuất sửa code và mở **pull request vào `dat-dev`** để người review.

> Agent **không bao giờ merge**, không push thẳng vào `dat-dev`/`main`, không force-push. Mọi PR đều phải được người review.

## Agent làm gì trong mỗi chu kỳ

1. **Đọc log tăng dần** (`logs/smc-futures-api/out.log`, `error.log`) bằng con trỏ byte lưu trong `state/cursors.json`. Agent tự phát hiện file bị truncate hoặc rotate (kích thước nhỏ đi, inode đổi, hash 256 byte đầu đổi), giữ lại dòng cuối chưa hoàn chỉnh cho lần đọc sau và giới hạn số byte mỗi lần đọc (`MAX_READ_BYTES`). Agent hỗ trợ cả log JSON production (`{timestamp, level, component, message, ...}`, có hoặc không có tiền tố thời gian của pm2) lẫn log dev (`[ISO] LEVEL message: reason`).
2. **Tạo digest gọn**, có giới hạn ký tự `DIGEST_MAX_CHARS` để vừa với model local. Digest gồm:
   - cửa sổ thời gian;
   - số lần `[ENTRY REJECTED]` theo `reason`;
   - số lần `Entry plan rejected before risk manager` theo reason và classification;
   - số lần `[FUNNEL] candidate archived` theo reason (`ENTRY_WINDOW_EXPIRED`, `PRICE_BEYOND_PROTECTION`, ...);
   - `Execution submission failed` theo `code`;
   - `[RUNTIME] ... failed` và `[SCANNER] scan failed`;
   - các vấn đề protection;
   - số lượng từng stage funnel theo symbol và tỉ lệ rơi rụng giữa các stage;
   - ước lượng số lệnh đã vào (`RISK_PASSED` trừ đi số lần submission failed);
   - mẫu lỗi đã khử trùng lặp và cắt ngắn.
3. **Chỉ chạy khi đủ tín hiệu mới**: số dòng mới ≥ `MIN_NEW_LINES` hoặc số sự kiện reject/archive/lỗi ≥ `MIN_SIGNAL_EVENTS`. Nếu chưa đủ, agent giữ nguyên con trỏ để log tiếp tục tích luỹ.
4. **Bộ nhớ học tập** nằm ở `state/memory.json`. Agent lưu từng lần chạy, các giả thuyết/PR đã thử và kết quả của chúng. Mỗi chu kỳ, agent gọi `gh pr view` để biết PR đã merged hay closed và lấy review/comment. Phần bộ nhớ liên quan được đưa vào prompt, để LLM không đề xuất lại ý đã bị từ chối và xây tiếp trên các thay đổi đã được merge.
5. **LLM bước 1 (diagnose)**: agent gửi digest, bộ nhớ, `trading_rules.md` và `docs/ai/bot-analysis-skill.md` (nếu file này tồn tại). LLM trả về JSON gồm findings, severity, có cần sửa code hay không, và danh sách file cần đọc. Agent chỉ đọc các file nằm trong vùng cho phép, lấy nội dung từ `origin/dat-dev`.
6. **Cổng PR**: nếu đã có `MAX_OPEN_AI_PRS` (mặc định 1) PR `ai-generated` đang mở, agent chỉ ghi report.
7. **LLM bước 2 (patch)**: LLM trả về JSON `{title, body, diff}`, trong đó diff là unified diff và phải kèm test. Nếu model không nhét được diff vào JSON, agent chấp nhận một khối ```` ```diff ```` riêng.
8. **Kiểm tra diff** (xem phần An toàn), rồi áp dụng trong một **git worktree riêng** tạo từ `origin/dat-dev`, trên nhánh `ai/<yyyyMMdd-HHmm>-<slug>`. Agent chạy `git apply --check` trước khi apply.
9. Agent chạy **`tsc --noEmit` và toàn bộ vitest của `apps/api`** trong worktree. Nếu fail, lỗi được gửi lại cho LLM để sửa, tối đa `MAX_FIX_ATTEMPTS` lần (mặc định 2). Nếu vẫn đỏ, agent bỏ cuộc: xoá worktree và nhánh, rồi ghi thất bại vào bộ nhớ.
10. Nếu **xanh** và đã tắt dry-run, agent commit với tác giả `AI Dev Agent <ai-dev-agent@local>`, push **chỉ** nhánh `ai/...`, rồi chạy `gh pr create --base dat-dev --label ai-generated`. Nếu label chưa tồn tại, agent tự tạo. PR body gồm digest, findings, lý do, kết quả test và ghi chú "AI-generated, requires human review".
11. Mọi kết quả (không cần sửa, diff bị từ chối, bỏ cuộc, dry-run, PR) đều được ghi report Markdown vào `reports/<timestamp>-<kind>.md`.

## Cài đặt

```bash
# tại thư mục gốc repo
npm install                      # tools/ai-dev-agent là một npm workspace
cp tools/ai-dev-agent/.env.example tools/ai-dev-agent/.env
# sửa AI_BASE_URL / AI_MODEL / AI_API_KEY cho LLM local
gh auth login                    # cần khi tắt dry-run (và để đọc trạng thái PR)
```

Yêu cầu:

- Node >= 20, `git` và `gh` có trong PATH.
- **Nhánh `dat-dev` phải tồn tại trên `origin`** (`git push origin dat-dev`). Agent tạo worktree từ `origin/dat-dev` và mở PR vào `dat-dev`. Nếu nhánh này chưa có, chu kỳ sẽ dừng và ghi lỗi vào report.
- LLM local tương thích OpenAI, có endpoint `POST {AI_BASE_URL}/chat/completions`. Mặc định là `http://localhost:20128/v1`.

## Chạy

```bash
# In digest (không gọi LLM, không đụng git, không di chuyển con trỏ)
npm run digest -w @smc-futures-bot/ai-dev-agent
# Với file log mẫu
npm run digest -w @smc-futures-bot/ai-dev-agent -- --log tools/ai-dev-agent/tests/fixtures/sample-out.log --log tools/ai-dev-agent/tests/fixtures/sample-error.log

# Chạy một chu kỳ rồi thoát (bỏ qua ngưỡng tín hiệu bằng --force)
npm run start -w @smc-futures-bot/ai-dev-agent -- --once
npm run start -w @smc-futures-bot/ai-dev-agent -- --once --force

# Chạy vòng lặp mỗi INTERVAL_MINUTES phút
npm run start -w @smc-futures-bot/ai-dev-agent
npm run ai-agent                 # lối tắt ở package.json gốc

# Kiểm tra
npm run test -w @smc-futures-bot/ai-dev-agent
npm run typecheck -w @smc-futures-bot/ai-dev-agent
```

Các tham số dòng lệnh:

- `--once`: chạy một chu kỳ rồi thoát.
- `--digest-only`: chỉ in digest.
- `--force`: bỏ qua `MIN_NEW_LINES` và `MIN_SIGNAL_EVENTS`.
- `--from-start`: dùng cùng `--digest-only` để đọc log từ đầu.
- `--log <path>`: ghi đè `LOG_PATHS`, có thể lặp lại.

**Dry-run mặc định BẬT.** Ở chế độ này agent làm mọi bước đến hết phần test (worktree, apply, typecheck, vitest), nhưng không commit, không push, không mở PR. Agent chỉ in ra những gì nó *sẽ* làm, rồi ghi report kèm diff và PR body dự kiến. Muốn mở PR thật, đặt `AI_DEV_AGENT_DRY_RUN=false`; mọi giá trị khác đều giữ dry-run.

### Chạy bằng pm2 (chỉ là ví dụ, KHÔNG sửa `ecosystem.config.cjs`)

Tạo một file riêng, ví dụ `ai-dev-agent.pm2.config.cjs` đặt ngoài repo hoặc không commit:

```js
const path = require("node:path");
const repo = "/path/to/bot_trade_feature_binance";

module.exports = {
  apps: [
    {
      name: "ai-dev-agent",
      cwd: path.join(repo, "tools/ai-dev-agent"),
      script: path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      args: "src/main.ts",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 60000,
      time: true,
      out_file: path.join(repo, "logs/ai-dev-agent/out.log"),
      error_file: path.join(repo, "logs/ai-dev-agent/error.log"),
      env: { AI_DEV_AGENT_DRY_RUN: "true" }
    }
  ]
};
```

```bash
pm2 start ai-dev-agent.pm2.config.cjs && pm2 logs ai-dev-agent
```

Agent dùng file khoá `state/agent.lock`, nên hai tiến trình không thể chạy chồng lên nhau.

## Mô hình an toàn

| Bảo đảm | Cách thực thi |
| --- | --- |
| Không merge, không push vào `dat-dev`/`main`, không force-push | Mọi lệnh đều đi qua `SafeCommandRunner` (`src/commandRunner.ts`). Bộ lọc này chỉ cho chạy `git`, `gh` và chính binary `node`. `git push` chỉ được chấp nhận ở dạng `push <remote> ai/x:refs/heads/ai/x`; mọi `--force`/`-f`/`--force-*`/`+refspec`/`--delete` đều bị chặn. Các lệnh `git merge`/`rebase`/`update-ref`, global option `-c`/`-C`, và `gh pr merge|close|review`, `gh api|repo|release|secret|workflow` cũng bị chặn. `gh pr create` bắt buộc có `--base` và `--head ai/...`. |
| LLM không thể chạy lệnh | Output của LLM chỉ được parse thành JSON hoặc chuỗi diff và được zod kiểm tra. Agent không bao giờ dùng shell (`execFile` với mảng tham số, `shell: false`). Diff được ghi ra file và chỉ được đưa vào `git apply`. |
| Chỉ sửa đúng vùng cho phép | `src/diffValidator.ts` chỉ cho phép `apps/api/src/**`, `apps/api/tests/**`, `apps/web/**`, `docs/**` và `trading_rules.md`. |
| Những path luôn bị cấm | `.env*`, `ecosystem.config.cjs`, `deploy-api.sh`, `package*.json`, `tools/ai-dev-agent/**` (agent không được tự sửa mình), `LockedRealExecutionGateway.ts`, `RealExecutionProposal*`, `ExecutionPolicy.ts`, `.git/`, `.github/`, `.claude/`. Agent cũng chặn path tuyệt đối, `..`, backslash, rename/copy, đổi mode, symlink và binary patch. |
| Không lật cơ chế khoá giao dịch thật | Mọi dòng **được thêm hoặc bị xoá** đều bị quét tìm `realLiveExecutionEnabled`, `REAL_LIVE_EXECUTION_ENABLED`, `REAL_EXECUTION_LOCKED`, `realExecutionMode`, `LockedRealExecutionGateway`, `RealExecutionProposal`, `ExecutionPolicy`, `testnet`/`mainnet`, `child_process`/`execSync`, và credential bị hard-code. Có bất kỳ token nào là diff bị từ chối. Vi phạm bảo mật không được gửi lại cho LLM để "sửa". |
| Giới hạn kích thước | `MAX_FILES` (mặc định 8) và `MAX_CHANGED_LINES` (mặc định 400). |
| Phòng thủ nhiều lớp | Sau `git apply`, agent so `git status` với danh sách path đã kiểm tra và **kiểm tra lại diff do chính git sinh ra** (`git diff --cached`). Trước khi push, agent kiểm tra `git diff --name-only origin/dat-dev...HEAD` và đảm bảo HEAD đúng là nhánh `ai/...`. Các thao tác `reset --hard`, `worktree add/remove` chỉ được phép bên trong thư mục worktree của agent. |
| Tối đa 1 PR AI đang mở | Agent kiểm tra `gh pr list --label ai-generated --state open` trước bước patch và kiểm tra lại ngay trước khi push. Ở chế độ live, nếu `gh` lỗi thì cổng **đóng** (fail-safe). |
| Dry-run mặc định | `AI_DEV_AGENT_DRY_RUN` phải đúng bằng `false` thì mới publish. |
| Không lộ bí mật | Agent không đọc `.env`. Context có tên chứa secret/token/password/apiKey bị loại khỏi digest. |

### Cài dependency trong worktree

Mặc định `WORKTREE_INSTALL=link`: agent tạo junction (Windows) hoặc symlink `worktree/node_modules` trỏ về `node_modules` của repo. Cách này đáng tin cậy vì:

- validator **cấm mọi thay đổi `package*.json`**, nên tập dependency của worktree luôn giống hệt repo;
- `apps/api` không import workspace package nào khác.

Trước khi xoá worktree, agent gỡ link (`unlink`), nên không bao giờ xoá xuyên qua link vào `node_modules` thật. Nếu muốn cô lập hoàn toàn, đặt `WORKTREE_INSTALL=ci`; khi đó agent chạy `npm ci` bên trong worktree, chậm hơn. Worktree nằm ở `<OS temp>/ai-dev-agent-worktrees`, có thể đổi bằng `WORKTREE_DIR`.

## Cấu trúc

```
tools/ai-dev-agent/
  src/main.ts            CLI + vòng lặp + file khoá
  src/config.ts          đọc .env (zod)
  src/logs/parseLine.ts  parse log JSON/dev/pm2
  src/logs/logReader.ts  đọc tăng dần, con trỏ, rotation
  src/digest.ts          tổng hợp + render có giới hạn ký tự
  src/memory.ts          bộ nhớ học tập + gh pr view
  src/llm.ts             client OpenAI-compatible + trích JSON bền vững
  src/prompts.ts         prompt diagnose/patch/fix
  src/diffValidator.ts   kiểm tra path/nội dung/giới hạn
  src/git.ts             thao tác worktree/apply/commit/push
  src/github.ts          cổng PR, label, gh pr create
  src/toolchain.ts       link/npm ci, tsc, vitest
  src/cycle.ts           pipeline của một chu kỳ
  tests/                 vitest (+ fixtures log mẫu)
  state/   (gitignored)  memory.json, cursors.json, patches/
  reports/ (gitignored)  report Markdown
```
