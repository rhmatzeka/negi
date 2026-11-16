# Fonts

`mono-regular.woff2` and `mono-bold.woff2` are subsets of JetBrainsMono Nerd Font
(Regular and Bold), made with `pyftsubset`.

JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors
(https://github.com/JetBrains/JetBrainsMono), SIL Open Font License 1.1,
https://scripts.sil.org/OFL. The added symbol glyphs come from the Nerd Fonts project
(https://github.com/ryanoasis/nerd-fonts), which lists each glyph set's own licence.

The subset keeps Latin, punctuation, arrows, box drawing, block and braille characters,
and the common prompt and file-type symbols.

`symbols.woff2` holds the rest of the Nerd Font icons (private-use code points the mono
subset lacks, Material Design and Codicons among them), cut from JetBrainsMono Nerd Font
Regular 3.4.0 with `fontTools.subset`. The page loads it through `unicode-range`, so only
a screen that shows one of those icons fetches it.

The interface face, Figtree, comes from the `@fontsource-variable/figtree` package (SIL
Open Font License 1.1) and is bundled by the build.
