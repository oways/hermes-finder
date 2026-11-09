![Finder - search and organise your Hermes projects and sessions](assets/banner.png)

<h1 align="center">Finder for Hermes Desktop</h1>

<p align="center">
  Find any project or session in seconds, right from the sidebar.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Hermes-Desktop%20Plugin-6366f1?style=flat-square" alt="Hermes Desktop Plugin" />
  <a href="https://hermes-agent.nousresearch.com/docs/plugins/finder"><img src="https://img.shields.io/badge/Hermes%20Marketplace-listed-22c55e?style=flat-square" alt="Listed in the Hermes Marketplace" /></a>
  <img src="https://img.shields.io/badge/version-v1.1.0-6366f1?style=flat-square" alt="Version 1.1.0" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license" />
</p>

---

## 🔎 What it is

Hermes' built-in sidebar search never looks at the **project** a session belongs
to, and cannot search projects by name at all. Finder adds a **Finder** tab to
the sidebar with one search box that spans your whole workspace.

## ✨ Features

- 🗂️ **Search projects by name**, plus session title, preview, folder, git branch, repo, source and model.
- 🧭 **Four views:** All, Groups, Projects and Sessions.
- 📁 **Groups.** Organise projects into your own groups and move projects between them.
- 🫥 **Privacy / blur.** Hide sensitive names per project, per group, or all at once.
- 📌 **Pin** the projects and sessions you use most.
- ↕️ **Sort** by last active, name, token use, cost, or a custom order.
- ☑️ **Multi-select** sessions for bulk archive, delete, colour or move.
- 🖱️ **Right-click menus** to create, rename, recolour, move, archive and delete.
- 📊 **Token and cost stats** per session and per project, plus a live context meter.
- ♻️ **Always fresh.** Updates live as projects and sessions change.

## ⬇️ Install

From the [Hermes Marketplace](https://hermes-agent.nousresearch.com/docs/plugins/finder):

```bash
hermes plugins install finder
```

Then run **Reload desktop plugins** from the Command Palette (Cmd/Ctrl + K).

## ⌨️ Opening it

- Click the **Finder** tab in the sidebar.
- Press **Cmd/Ctrl + Alt + F**.
- Command Palette: **Find projects & sessions**.

## 🔒 Privacy and safety

Desktop only. It uses the public plugin SDK, makes no network calls and sends no
telemetry. Your colours, order and preferences are stored locally. Everything it
shows comes from your own gateway.

## 🧩 Requirements

Hermes Desktop version 0.22 or newer.

## 📄 License

MIT. See [LICENSE](LICENSE).
