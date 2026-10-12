# tg2tm

Phone login for Telemost lives in `vm/` and `.github/workflows/telemost-session.yml`. Steps, secrets, and what to do if the US runner sticks on «Подключение…» are in `docs/telemost-login-vm.md`.

`/login` and `/connect` on @tg2tmbot call `workflow_dispatch` for this file. GitHub accepts that call only after the workflow is on the default branch (`main`).
