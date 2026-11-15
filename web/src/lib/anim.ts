// GSAP, set up once. Everything that moves goes through here.

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { useApp } from "./store";

gsap.registerPlugin(useGSAP, Flip);

/** True for people who asked their system for less motion, or who paused it here: nothing animates for them. */
export const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches || !useApp.getState().motion;

export { Flip, gsap, useGSAP };
