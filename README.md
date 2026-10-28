# KoolMate — AI File Assistant

KoolMate is a desktop app that helps university students stop losing files. You can **find any file in any folder by describing it in plain language**, and when you **download a file, KoolMate detects it and suggests where it belongs**. It never moves anything until you confirm, never renames your files, and every move can be undone.

It is built from the findings of our FWS310 empathy interviews and brainwriting session: students let files pile up in Downloads, lose time searching, want natural-language commands, and will only trust automation that previews changes, offers undo, keeps original names and processes files locally.

## Features

| What students asked for | What KoolMate does |
| --- | --- |
| "Find my Genetics materials" in natural language | **Assistant**: type a request like *"Distributed systems lecture slides PDF from last week"*. It understands courses (codes, names, nicknames), file types, material types and dates, searches every folder you allow, and shows **why** each file matched. |
| Sort the results for me | Requests such as *"Find all my Genetics course materials and organize them"* open a **preview** that groups files into Lectures / Assignments / Labs / Exams… in a new folder. |
| Sort a whole messy folder for me | **Sort**: pick any folder. KoolMate opens files whose names say nothing (PDF, Word, PowerPoint, Excel, text), works out the course, material type and semester, then proposes an **existing folder or a new one** that follows your own structure, e.g. `Fall 2026 / Operating Systems / Lecture Materials`. You review, change any destination, and confirm. |
| Don't make me sort Downloads manually | **Download detection**: a watcher notices when a download finishes (ignores half-downloaded `.crdownload` / `.part` files), reads the course code, material type, week and download source (e.g. Blackboard), **opens the file when its name is unclear**, and suggests a destination (existing folder first, otherwise the exact new folder to create) with a confidence score and the reason. |
| A quick pop-up, not a navigation chore | A small always-on-top **pop-up** offers *Move here*, *Change* (alternatives, recently used folders, Browse) or *Later*. |
| Don't ever lose or rename my files | Preview before every change, **Undo** for single files and whole batches, an **Activity log**, original names kept (a name clash becomes `name (1).pdf`), system folders are blocked as destinations. |
| Keep my files private | Everything runs on your computer. You choose search locations and **excluded folders**. Files are read locally. The optional Gemini AI receives your request, file and folder names and, only if *AI may read short excerpts* is on, the first ~1,500 characters of a file whose name is unclear (images are sent only when that setting is on). |
| Learns from me | Your accepted choices (course → folder, file type → folder) improve later suggestions. Stored locally. |

KoolMate also works **fully offline**: AI (Google Gemini) is optional and only refines results. Add a key in *Settings → AI assistance*.

## Download

Get the latest installer from the **[Releases](../../releases)** page:

- `KoolMate-Setup-<version>.exe` — installer (recommended)
- `KoolMate-Portable-<version>.exe` — runs without installing
- `KoolMate-<version>-win-x64.zip` — unpacked app
- `KoolMate-<version>-mac-arm64.dmg` — Mac with Apple Silicon (M1/M2/M3/M4)
- `KoolMate-<version>-mac-x64.dmg` — Mac with an Intel processor (`.zip` versions are also provided)

> The builds are unsigned. **Windows:** SmartScreen may show "Windows protected your PC": choose **More info → Run anyway**.
> **Mac:** open the `.dmg`, drag KoolMate to *Applications*, then **right-click the app → Open → Open** the first time. If macOS says the app is "damaged", run `xattr -cr /Applications/KoolMate.app` once in Terminal and open it again.

## 5-minute demo script

1. Open **Settings → Demo workspace → Load demo workspace**. This creates sample courses, folders and PDFs in `Documents/KoolMate Demo`.
2. **Assistant**: search *"operating systems assignments"*, then *"PDFs from last week"*.
3. Search *"Find all my Genetics course materials and organize them"* → **Preview organization** → confirm → show **Activity → Undo all**.
4. **Downloads → Simulate download**. A pop-up appears with a suggested course folder and a confidence score. Click **Move here**, then show the entry in **Activity** and undo it.
5. Click **Simulate download** a few more times: one file is unknown (`Signal.pdf`), so it is flagged **Needs review** instead of being guessed.
6. **Sort → Demo · Sort Me**: six files with meaningless names (`scan_0042.pdf`, `untitled.txt`…) are opened and matched to the right semester/course/material folder, or a new one. Change a destination, then **Move**.
7. Optional: **Settings → AI assistance**, paste a Gemini key, and repeat step 2 to show *Gemini-assisted*.

## Develop

Requirements: Node.js 20+ (22 recommended).

```bash
npm install
npm test                # engine tests (search, suggestions, watcher, move/undo)
npm start               # build the UI and run the desktop app
npm run electron:dev    # hot-reload UI + Electron
npm run dev             # UI only in a browser, with an in-memory mock API
```

### Build installers

```bash
npm run dist            # on Windows: release/KoolMate-Setup-x.y.z.exe + Portable + zip
npm run dist:mac        # on a Mac: release/KoolMate-x.y.z-mac-arm64.dmg and -x64.dmg (+ zip)
```

### Publish a GitHub Release

The workflow in `.github/workflows/release.yml` builds on a Windows runner and a macOS runner and attaches the Windows and Mac files to a release whenever a version tag is pushed:

```bash
git add -A
git commit -m "KoolMate 1.0.0"
git tag v1.0.0
git push origin main --tags
```

You can also run it manually from the **Actions** tab (*Release → Run workflow*); the files are then available as a build artifact.

## How it works

```
electron/
  main.js            window, tray, download pop-up, secure IPC
  preload.js         the only bridge exposed to the UI (window.koolmate)
  services/
    indexer.js       walks the folders you allow into an in-memory file index
    queryPlanner.js  natural language → structured query (courses, types, dates, intent)
    search.js        scores files by name / folder / type / recency and explains matches
    watcher.js       detects finished downloads; reads the download source (Windows)
    classifier.js    course + type + week + similarity + learned habits → folder suggestion
    contentReader.js reads short text excerpts from PDF / docx / pptx / xlsx / text files
    smartSort.js     content understanding + semester/course/type folder resolver (existing or new)
    mover.js         safe move, conflict handling, undo, protected-folder checks
    organizer.js     preview for "organize these results"
    gemini.js        optional AI refinement with strict validation and local fallback
    store.js         settings, activity and learned preferences as small JSON files
src/                 React + Tailwind interface (Assistant, Sort, Downloads, Activity, Settings, pop-up)
tests/               automated tests for the engine
```

There is no database and no server: settings, the undo journal and learned preferences are JSON files in the app's user-data folder. The Gemini key is encrypted with the operating-system account (Electron `safeStorage`).

## License

MIT
