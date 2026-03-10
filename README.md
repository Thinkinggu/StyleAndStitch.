# StyleAndStitch.

Virtual styler and pattern stitch maker.

## Current project status

This repository is currently a **very early scaffold**. It now includes a starter static `contact.html` page as an initial UI artifact, but there is not yet an application runtime, package manifest, or automated tests.

## Available pages

- `index.html` – a simple landing page with a **Get Started** button linking to `contact.html`.
- `contact.html` – a responsive contact page for inquiries and feedback.

To preview locally:

```bash
xdg-open index.html
```

(or open either file directly in your browser)

## Suggested structure as the project grows

When you start building, a practical baseline layout would be:

- `app/` or `src/` for core product logic
- `ui/` (or framework-equivalent) for visual components
- `services/` for integrations (AI styling, garment metadata, image processing)
- `tests/` for automated test coverage
- `docs/` for architecture notes, product requirements, and onboarding guides

## Important things for newcomers to know

1. The first implemented page is a static contact form intended to seed UI conventions.
2. The main project vision is fashion-focused tooling: virtual styling plus pattern/stitch generation.
3. Early decisions you make now (language, framework, data model, testing strategy) will strongly shape future development speed.

## Recommended learning path (next steps)

1. Define an MVP scope in `docs/` (e.g., one outfit recommendation flow or one stitch pattern flow).
2. Choose a stack and add a runnable app skeleton.
3. Add basic CI checks (format, lint, tests).
4. Add architecture docs for domain entities (garment, body profile, pattern template, stitch instruction).
5. Start with one end-to-end feature and test it before expanding.
