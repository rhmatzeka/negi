// Runs before anything else is imported.

import { z } from "zod";
import { initTheme } from "@/lib/theme";

// zod probes for `new Function` to compile its checks, which this app's content policy
// forbids. Tell it not to try.
z.config({ jitless: true });

// Before the first paint, so the page never flashes the other theme.
initTheme();
