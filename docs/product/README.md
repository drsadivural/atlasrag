# UXE Consulting AI Design and Implementation Package

This package contains the production implementation prompt, four high-fidelity screen concepts, the consultant character, the original visual reference, and reusable image-generation prompts.

## Package contents

```text
UXE_Consulting_AI_Package/
├── IMPLEMENTATION_PROMPT.md
├── UI_IMAGE_PROMPTS.md
├── RESEARCH_NOTES.md
└── assets/
    ├── consultantgirl.png
    ├── reference/
    │   └── consultant-main.png
    └── screens/
        ├── 01-login.png
        ├── 02-dashboard.png
        ├── 03-knowledge-base.png
        └── 04-consult-now.png
```

## How to use

1. Copy the package into the root of the application repository.
2. Open Claude Code or Codex in that repository.
3. Paste the complete contents of `IMPLEMENTATION_PROMPT.md`.
4. Keep `assets/consultantgirl.png` unchanged as the canonical Ayumi character asset.
5. Treat the four files in `assets/screens/` as the primary visual acceptance references.
6. Require implementation screenshots at the same desktop size and compare them against the concepts before accepting the work.

## Product identity

- Product: **UXE Consulting AI**
- Consultant: **Ayumi**
- Promise: **Verified answers. Exact evidence. Corrected documents.**
- Primary interaction modes: **Yes / No**, **Optimal**, **Details + references**

## Important implementation interpretation

The UI images define visual hierarchy and product behavior, but generated text inside a mockup is not the final data contract. The implementation prompt is authoritative for security, evidence verification, permissions, document versioning, correction safety, tests, and deployment.

