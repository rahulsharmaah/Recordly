import {
	ArrowCounterClockwiseIcon,
	ArrowUpRightIcon,
	CircleIcon,
	CursorIcon,
	EraserIcon,
	FlashlightIcon,
	HighlighterIcon,
	PaintBrushIcon,
	PencilSimpleIcon,
	RectangleIcon,
	TextTIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FreehandTool = "pencil" | "brush" | "highlighter";
type ShapeTool = "circle" | "rectangle" | "arrow";
type Tool = FreehandTool | ShapeTool | "text";
type Point = { x: number; y: number; t: number };

type StrokeMark = {
	kind: "stroke";
	id: number;
	tool: FreehandTool;
	color: string;
	points: Point[];
	widths: number[];
	baseOpacity: number;
	settledAt: number;
};
type ShapeMark = {
	kind: "shape";
	id: number;
	tool: ShapeTool;
	color: string;
	start: Point;
	end: Point;
	constrain: boolean;
	lineWidth: number;
	baseOpacity: number;
	settledAt: number;
};
type TextMark = {
	kind: "text";
	id: number;
	color: string;
	position: Point;
	text: string;
	fontSize: number;
	baseOpacity: number;
	settledAt: number;
};
type Mark = StrokeMark | ShapeMark | TextMark;

const COLORS = ["#ff3b5c", "#ffbd2e", "#35d07f", "#41a3ff", "#f8fafc"];
const SIZE_STEPS = [
	{ scale: 0.65, label: "S" },
	{ scale: 1, label: "M" },
	{ scale: 1.6, label: "L" },
];
const TOOLS: { value: Tool; label: string; Icon: typeof PencilSimpleIcon; shortcut: string }[] = [
	{ value: "pencil", label: "Pencil", Icon: PencilSimpleIcon, shortcut: "1" },
	{ value: "brush", label: "Brush", Icon: PaintBrushIcon, shortcut: "2" },
	{ value: "highlighter", label: "Highlighter", Icon: HighlighterIcon, shortcut: "3" },
	{ value: "arrow", label: "Arrow", Icon: ArrowUpRightIcon, shortcut: "4" },
	{ value: "circle", label: "Circle", Icon: CircleIcon, shortcut: "5" },
	{ value: "rectangle", label: "Box", Icon: RectangleIcon, shortcut: "6" },
	{ value: "text", label: "Text", Icon: TextTIcon, shortcut: "7" },
];

const HOLD_MS = 850;
const FADE_MS = 650;
const SHAPE_LINE_WIDTH = 3.5;
const TEXT_BASE_FONT_SIZE = 26;
const SETTINGS_SAVE_DEBOUNCE_MS = 300;

const STROKE_WIDTH: Record<FreehandTool, { base: number; min: number; taper: number }> = {
	pencil: { base: 3, min: 1.75, taper: 1.25 },
	brush: { base: 12, min: 4.5, taper: 8.5 },
	highlighter: { base: 22, min: 22, taper: 0 },
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function isFreehand(tool: Tool): tool is FreehandTool {
	return tool === "pencil" || tool === "brush" || tool === "highlighter";
}

function isShapeTool(tool: Tool): tool is ShapeTool {
	return tool === "circle" || tool === "rectangle" || tool === "arrow";
}

function widthFor(
	tool: FreehandTool,
	prev: Point,
	next: Point,
	pressure: number,
	pointerType: string,
	sizeScale: number,
): number {
	const cfg = STROKE_WIDTH[tool];
	const base = cfg.base * sizeScale;
	if (tool === "highlighter") return base;
	const min = cfg.min * sizeScale;
	const dt = Math.max(1, next.t - prev.t);
	const dist = Math.hypot(next.x - prev.x, next.y - prev.y);
	const speedFactor = Math.min(1, dist / dt / 1.6);
	let width = base - cfg.taper * sizeScale * speedFactor;
	if (pointerType === "pen" && pressure > 0) {
		width *= 0.55 + pressure * 0.9;
	}
	return Math.max(min, Math.min(base * 1.15, width));
}

// The highlighter is translucent, so stroking it segment-by-segment makes
// every overlapping round cap composite against itself and the stroke reads as
// a chain of dark blobs. Building one continuous path and stroking it a single
// time keeps the alpha perfectly uniform along the whole mark.
function paintUniformStrokePath(
	ctx: CanvasRenderingContext2D,
	color: string,
	points: Point[],
	lineWidth: number,
) {
	if (points.length === 0) return;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = lineWidth;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	if (points.length === 1) {
		ctx.beginPath();
		ctx.arc(points[0].x, points[0].y, Math.max(1, lineWidth / 2), 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	ctx.beginPath();
	ctx.moveTo(points[0].x, points[0].y);
	for (let index = 1; index < points.length - 1; index += 1) {
		const current = points[index];
		const next = points[index + 1];
		ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
	}
	const last = points[points.length - 1];
	ctx.lineTo(last.x, last.y);
	ctx.stroke();
}

function paintStrokePath(ctx: CanvasRenderingContext2D, color: string, points: Point[], widths: number[]) {
	if (points.length === 0) return;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	if (points.length === 1) {
		ctx.beginPath();
		ctx.arc(points[0].x, points[0].y, Math.max(1, widths[0] / 2), 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	let prev = points[0];
	let lastMid: Point = points[0];
	for (let index = 1; index < points.length; index += 1) {
		const current = points[index];
		const mid: Point = { x: (prev.x + current.x) / 2, y: (prev.y + current.y) / 2, t: current.t };
		ctx.beginPath();
		ctx.lineWidth = widths[index] ?? widths[widths.length - 1];
		ctx.moveTo(lastMid.x, lastMid.y);
		ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
		ctx.stroke();
		lastMid = mid;
		prev = current;
	}
	ctx.beginPath();
	ctx.lineWidth = widths[widths.length - 1];
	ctx.moveTo(lastMid.x, lastMid.y);
	ctx.lineTo(prev.x, prev.y);
	ctx.stroke();
}

function paintShape(
	ctx: CanvasRenderingContext2D,
	mark: Pick<ShapeMark, "tool" | "color" | "start" | "end" | "constrain" | "lineWidth">,
) {
	const { start, tool, color, constrain, lineWidth } = mark;
	ctx.strokeStyle = color;
	ctx.lineWidth = lineWidth;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	if (tool === "arrow") {
		const rawAngle = Math.atan2(mark.end.y - start.y, mark.end.x - start.x);
		const dist = Math.hypot(mark.end.x - start.x, mark.end.y - start.y);
		const angle = constrain ? Math.round(rawAngle / (Math.PI / 12)) * (Math.PI / 12) : rawAngle;
		const end = constrain
			? { x: start.x + Math.cos(angle) * dist, y: start.y + Math.sin(angle) * dist, t: mark.end.t }
			: mark.end;
		ctx.beginPath();
		ctx.moveTo(start.x, start.y);
		ctx.lineTo(end.x, end.y);
		ctx.stroke();
		const headLen = Math.max(14, lineWidth * 4.5);
		ctx.beginPath();
		ctx.moveTo(end.x, end.y);
		ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 7), end.y - headLen * Math.sin(angle - Math.PI / 7));
		ctx.moveTo(end.x, end.y);
		ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 7), end.y - headLen * Math.sin(angle + Math.PI / 7));
		ctx.stroke();
		return;
	}

	let end = mark.end;
	if (constrain) {
		const size = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
		end = {
			x: start.x + Math.sign(end.x - start.x || 1) * size,
			y: start.y + Math.sign(end.y - start.y || 1) * size,
			t: end.t,
		};
	}
	ctx.beginPath();
	if (tool === "rectangle") {
		const x = Math.min(start.x, end.x);
		const y = Math.min(start.y, end.y);
		const w = Math.abs(end.x - start.x);
		const h = Math.abs(end.y - start.y);
		ctx.roundRect(x, y, w, h, Math.min(10, w / 6, h / 6) || 0);
	} else {
		const cx = (start.x + end.x) / 2;
		const cy = (start.y + end.y) / 2;
		const rx = Math.max(6, Math.abs(end.x - start.x) / 2);
		const ry = Math.max(6, Math.abs(end.y - start.y) / 2);
		ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	}
	ctx.stroke();
}

function paintMark(ctx: CanvasRenderingContext2D, mark: Mark, fadeOpacity: number) {
	ctx.save();
	if (mark.kind === "stroke") {
		if (mark.tool === "highlighter") {
			ctx.globalCompositeOperation = "multiply";
			ctx.globalAlpha = 0.5 * fadeOpacity * mark.baseOpacity;
			paintUniformStrokePath(ctx, mark.color, mark.points, mark.widths[0]);
		} else {
			ctx.globalAlpha = fadeOpacity * mark.baseOpacity;
			paintStrokePath(ctx, mark.color, mark.points, mark.widths);
		}
	} else if (mark.kind === "shape") {
		ctx.globalAlpha = fadeOpacity * mark.baseOpacity;
		paintShape(ctx, mark);
	} else {
		ctx.globalAlpha = fadeOpacity * mark.baseOpacity;
		ctx.fillStyle = mark.color;
		ctx.font = `700 ${mark.fontSize}px system-ui, sans-serif`;
		ctx.textBaseline = "top";
		ctx.shadowColor = "rgba(0,0,0,.55)";
		ctx.shadowBlur = 6;
		mark.text
			.split("\n")
			.forEach((line, index) => ctx.fillText(line, mark.position.x, mark.position.y + index * mark.fontSize * 1.25));
	}
	ctx.restore();
}

function buildCursor(color: string, diameter: number): string {
	const size = Math.max(10, Math.min(46, Math.round(diameter)));
	const half = size / 2;
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><circle cx='${half}' cy='${half}' r='${half - 1}' fill='${color}' fill-opacity='0.3' stroke='${color}' stroke-width='1.5'/></svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${half} ${half}, crosshair`;
}

export function AnnotationOverlay() {
	const [tool, setTool] = useState<Tool>("brush");
	const [color, setColor] = useState(COLORS[0]);
	const [sizeScale, setSizeScale] = useState(1);
	const [opacity, setOpacity] = useState(1);
	const [pointerMode, setPointerMode] = useState(false);
	const [hoveringToolbar, setHoveringToolbar] = useState(false);
	const [spotlightOn, setSpotlightOn] = useState(false);
	const [textEditor, setTextEditor] = useState<{ x: number; y: number } | null>(null);

	const settledCanvasRef = useRef<HTMLCanvasElement>(null);
	const activeCanvasRef = useRef<HTMLCanvasElement>(null);
	const spotlightCanvasRef = useRef<HTMLCanvasElement>(null);
	const textAreaRef = useRef<HTMLTextAreaElement>(null);
	const sizeRef = useRef({ width: 0, height: 0 });
	const marksRef = useRef<Mark[]>([]);
	const nextIdRef = useRef(0);
	const fadeFrameRef = useRef<number | null>(null);
	const spotlightRadiusRef = useRef(220);
	const lastPointerPosRef = useRef<Point>({ x: 0, y: 0, t: 0 });
	const settingsLoadedRef = useRef(false);

	const strokeStateRef = useRef<{
		tool: FreehandTool;
		color: string;
		opacity: number;
		points: Point[];
		widths: number[];
		lastMid: Point;
		prevRaw: Point;
	} | null>(null);
	const shapeStateRef = useRef<{
		tool: ShapeTool;
		color: string;
		opacity: number;
		start: Point;
		end: Point;
		constrain: boolean;
		lineWidth: number;
	} | null>(null);

	const ignoringMouseRef = useRef(false);
	const setIgnoringMouse = useCallback((ignore: boolean) => {
		if (ignoringMouseRef.current === ignore) return;
		ignoringMouseRef.current = ignore;
		window.electronAPI?.annotationOverlaySetIgnoreMouse?.(ignore);
	}, []);

	// Pointer mode makes the whole overlay click-through so the user can reach
	// their screen normally. The toolbar stays reachable regardless of mode:
	// hovering it always re-enables capture (mirrors the HUD's own hover
	// passthrough pattern) so the button to leave pointer mode is never stuck
	// behind the very click-through state it controls.
	useEffect(() => {
		setIgnoringMouse(pointerMode && !hoveringToolbar);
	}, [pointerMode, hoveringToolbar, setIgnoringMouse]);

	const redrawSettled = useCallback((now: number) => {
		const canvas = settledCanvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return false;
		const { width, height } = sizeRef.current;
		ctx.clearRect(0, 0, width, height);
		let stillAnimating = false;
		marksRef.current = marksRef.current.filter((mark) => {
			const age = now - mark.settledAt;
			if (age >= HOLD_MS + FADE_MS) return false;
			const fadeOpacity = age <= HOLD_MS ? 1 : 1 - (age - HOLD_MS) / FADE_MS;
			paintMark(ctx, mark, fadeOpacity);
			if (age > HOLD_MS) stillAnimating = true;
			return true;
		});
		return stillAnimating;
	}, []);

	const ensureFadeLoop = useCallback(() => {
		if (fadeFrameRef.current !== null) return;
		const tick = () => {
			const animating = redrawSettled(performance.now());
			fadeFrameRef.current = animating || marksRef.current.length > 0 ? requestAnimationFrame(tick) : null;
		};
		fadeFrameRef.current = requestAnimationFrame(tick);
	}, [redrawSettled]);

	const clearActiveCanvas = useCallback(() => {
		const ctx = activeCanvasRef.current?.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, sizeRef.current.width, sizeRef.current.height);
	}, []);

	const commitMark = useCallback(
		(mark: Mark) => {
			const settledCtx = settledCanvasRef.current?.getContext("2d");
			if (settledCtx) paintMark(settledCtx, mark, 1);
			marksRef.current.push(mark);
			ensureFadeLoop();
		},
		[ensureFadeLoop],
	);

	const finishActive = useCallback(() => {
		const stroke = strokeStateRef.current;
		const shape = shapeStateRef.current;
		strokeStateRef.current = null;
		shapeStateRef.current = null;
		clearActiveCanvas();
		if (stroke) {
			commitMark({
				kind: "stroke",
				id: nextIdRef.current++,
				tool: stroke.tool,
				color: stroke.color,
				points: stroke.points,
				widths: stroke.widths,
				baseOpacity: stroke.opacity,
				settledAt: performance.now(),
			});
		} else if (shape) {
			commitMark({
				kind: "shape",
				id: nextIdRef.current++,
				tool: shape.tool,
				color: shape.color,
				start: shape.start,
				end: shape.end,
				constrain: shape.constrain,
				lineWidth: shape.lineWidth,
				baseOpacity: shape.opacity,
				settledAt: performance.now(),
			});
		}
	}, [clearActiveCanvas, commitMark]);

	const cancelActive = useCallback(() => {
		strokeStateRef.current = null;
		shapeStateRef.current = null;
		clearActiveCanvas();
	}, [clearActiveCanvas]);

	const undoLast = useCallback(() => {
		if (strokeStateRef.current || shapeStateRef.current) {
			cancelActive();
			return;
		}
		if (marksRef.current.length === 0) return;
		marksRef.current.pop();
		redrawSettled(performance.now());
	}, [cancelActive, redrawSettled]);

	const clearAll = useCallback(() => {
		cancelActive();
		marksRef.current = [];
		redrawSettled(performance.now());
	}, [cancelActive, redrawSettled]);

	const commitTextEditor = useCallback(() => {
		const value = textAreaRef.current?.value.trim();
		const position = textEditor;
		setTextEditor(null);
		if (!value || !position) return;
		commitMark({
			kind: "text",
			id: nextIdRef.current++,
			color,
			position: { x: position.x, y: position.y, t: performance.now() },
			text: value,
			fontSize: Math.round(TEXT_BASE_FONT_SIZE * sizeScale),
			baseOpacity: opacity,
			settledAt: performance.now(),
		});
	}, [textEditor, color, sizeScale, opacity, commitMark]);

	const cancelTextEditor = useCallback(() => setTextEditor(null), []);

	// Load the last-used tool/color/size/opacity, then persist changes
	// (debounced) so the next time the overlay opens it picks up where the
	// user left off instead of always resetting to the defaults.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const result = await window.electronAPI?.getAnnotationOverlaySettings?.();
				if (cancelled || !result?.success) return;
				const settings = result.settings;
				if (TOOLS.some((entry) => entry.value === settings.tool)) setTool(settings.tool as Tool);
				if (typeof settings.color === "string" && settings.color) setColor(settings.color);
				if (typeof settings.sizeScale === "number") setSizeScale(clamp(settings.sizeScale, 0.5, 2));
				if (typeof settings.opacity === "number") setOpacity(clamp(settings.opacity, 0.25, 1));
			} finally {
				settingsLoadedRef.current = true;
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!settingsLoadedRef.current) return;
		const handle = window.setTimeout(() => {
			window.electronAPI?.setAnnotationOverlaySettings?.({ tool, color, sizeScale, opacity });
		}, SETTINGS_SAVE_DEBOUNCE_MS);
		return () => window.clearTimeout(handle);
	}, [tool, color, sizeScale, opacity]);

	const drawSpotlight = useCallback(() => {
		const ctx = spotlightCanvasRef.current?.getContext("2d");
		if (!ctx) return;
		const { width, height } = sizeRef.current;
		ctx.clearRect(0, 0, width, height);
		if (!spotlightOn) return;
		const { x, y } = lastPointerPosRef.current;
		const radius = spotlightRadiusRef.current;
		ctx.save();
		ctx.fillStyle = "rgba(5, 8, 14, 0.6)";
		ctx.fillRect(0, 0, width, height);
		const gradient = ctx.createRadialGradient(x, y, radius * 0.6, x, y, radius);
		gradient.addColorStop(0, "rgba(0,0,0,1)");
		gradient.addColorStop(1, "rgba(0,0,0,0)");
		ctx.globalCompositeOperation = "destination-out";
		ctx.fillStyle = gradient;
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}, [spotlightOn]);

	useEffect(() => {
		drawSpotlight();
	}, [drawSpotlight]);

	useEffect(() => {
		if (textEditor) textAreaRef.current?.focus();
	}, [textEditor]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (strokeStateRef.current || shapeStateRef.current) {
					cancelActive();
				} else {
					window.electronAPI?.annotationOverlayClose?.();
				}
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
				event.preventDefault();
				undoLast();
				return;
			}
			if (event.key === "Backspace" || event.key === "Delete") {
				clearAll();
				return;
			}
			if (event.key.toLowerCase() === "p") {
				setPointerMode((value) => !value);
				return;
			}
			if (event.key.toLowerCase() === "s") {
				setSpotlightOn((value) => !value);
				return;
			}
			const match = TOOLS.find((entry) => entry.shortcut === event.key);
			if (match) {
				setTool(match.value);
				setPointerMode(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [cancelActive, clearAll, undoLast]);

	useEffect(() => {
		const onBlur = () => finishActive();
		window.addEventListener("blur", onBlur);
		return () => window.removeEventListener("blur", onBlur);
	}, [finishActive]);

	useEffect(() => {
		const setupCanvases = () => {
			const ratio = window.devicePixelRatio || 1;
			const width = window.innerWidth;
			const height = window.innerHeight;
			sizeRef.current = { width, height };
			for (const ref of [settledCanvasRef, activeCanvasRef, spotlightCanvasRef]) {
				const canvas = ref.current;
				if (!canvas) continue;
				canvas.width = Math.round(width * ratio);
				canvas.height = Math.round(height * ratio);
				canvas.style.width = `${width}px`;
				canvas.style.height = `${height}px`;
				const ctx = canvas.getContext("2d");
				ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
			}
			cancelActive();
			marksRef.current = [];
			drawSpotlight();
		};
		setupCanvases();
		window.addEventListener("resize", setupCanvases);
		return () => window.removeEventListener("resize", setupCanvases);
	}, [cancelActive, drawSpotlight]);

	useEffect(() => {
		return () => {
			if (fadeFrameRef.current !== null) cancelAnimationFrame(fadeFrameRef.current);
		};
	}, []);

	const pointFor = (clientX: number, clientY: number, rect: DOMRect): Point => ({
		x: clientX - rect.left,
		y: clientY - rect.top,
		t: performance.now(),
	});

	const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
		if (event.button !== 0 || pointerMode) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const point = pointFor(event.clientX, event.clientY, rect);

		if (tool === "text") {
			if (textEditor) return;
			setTextEditor({ x: point.x, y: point.y });
			return;
		}

		event.currentTarget.setPointerCapture(event.pointerId);
		if (isFreehand(tool)) {
			strokeStateRef.current = {
				tool,
				color,
				opacity,
				points: [point],
				widths: [widthFor(tool, point, point, event.pressure, event.pointerType, sizeScale)],
				lastMid: point,
				prevRaw: point,
			};
		} else if (isShapeTool(tool)) {
			shapeStateRef.current = {
				tool,
				color,
				opacity,
				start: point,
				end: point,
				constrain: event.shiftKey,
				lineWidth: SHAPE_LINE_WIDTH * sizeScale,
			};
		}
	};

	const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		if (spotlightOn) {
			lastPointerPosRef.current = pointFor(event.clientX, event.clientY, rect);
			drawSpotlight();
		}

		const stroke = strokeStateRef.current;
		const shape = shapeStateRef.current;
		if (!stroke && !shape) return;
		const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];

		if (stroke) {
			const ctx = activeCanvasRef.current?.getContext("2d");
			for (const sample of samples) {
				const point = pointFor(sample.clientX, sample.clientY, rect);
				const width = widthFor(stroke.tool, stroke.prevRaw, point, event.pressure, event.pointerType, sizeScale);
				stroke.points.push(point);
				stroke.widths.push(width);
				const mid: Point = { x: (stroke.prevRaw.x + point.x) / 2, y: (stroke.prevRaw.y + point.y) / 2, t: point.t };
				// The highlighter must be repainted as one whole path (below)
				// rather than appended to, so only opaque tools draw the new
				// segment incrementally here.
				if (ctx && stroke.tool !== "highlighter") {
					ctx.save();
					ctx.strokeStyle = stroke.color;
					ctx.lineCap = "round";
					ctx.lineJoin = "round";
					ctx.lineWidth = width;
					ctx.globalAlpha = stroke.opacity;
					ctx.beginPath();
					ctx.moveTo(stroke.lastMid.x, stroke.lastMid.y);
					ctx.quadraticCurveTo(stroke.prevRaw.x, stroke.prevRaw.y, mid.x, mid.y);
					ctx.stroke();
					ctx.restore();
				}
				stroke.lastMid = mid;
				stroke.prevRaw = point;
			}
			if (ctx && stroke.tool === "highlighter") {
				clearActiveCanvas();
				ctx.save();
				ctx.globalCompositeOperation = "multiply";
				ctx.globalAlpha = 0.5 * stroke.opacity;
				paintUniformStrokePath(ctx, stroke.color, stroke.points, stroke.widths[0]);
				ctx.restore();
			}
			return;
		}

		if (shape) {
			const last = samples[samples.length - 1];
			shape.end = pointFor(last.clientX, last.clientY, rect);
			shape.constrain = event.shiftKey;
			clearActiveCanvas();
			const ctx = activeCanvasRef.current?.getContext("2d");
			if (ctx) {
				ctx.save();
				ctx.globalAlpha = shape.opacity;
				paintShape(ctx, shape);
				ctx.restore();
			}
		}
	};

	const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
		if (!spotlightOn) return;
		event.preventDefault();
		spotlightRadiusRef.current = clamp(spotlightRadiusRef.current - event.deltaY * 0.3, 90, 480);
		drawSpotlight();
	};

	const cursor = useMemo(() => {
		if (pointerMode) return "default";
		if (tool === "text") return "text";
		if (isFreehand(tool)) return buildCursor(color, STROKE_WIDTH[tool].base * sizeScale);
		return "crosshair";
	}, [pointerMode, tool, color, sizeScale]);

	return (
		<div style={{ width: "100vw", height: "100vh", userSelect: "none" }}>
			<div
				onMouseEnter={() => setHoveringToolbar(true)}
				onMouseLeave={() => setHoveringToolbar(false)}
				style={{
					position: "fixed",
					top: 20,
					left: "50%",
					transform: "translateX(-50%)",
					display: "flex",
					flexWrap: "wrap",
					alignItems: "center",
					gap: 6,
					padding: 8,
					borderRadius: 16,
					background: "rgba(15, 20, 30, .82)",
					backdropFilter: "blur(14px)",
					color: "white",
					boxShadow: "0 12px 36px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.06)",
					zIndex: 3,
					maxWidth: "92vw",
					justifyContent: "center",
				}}
			>
				<button
					type="button"
					onClick={() => setPointerMode((value) => !value)}
					title="Pointer mode — click through to your screen (P)"
					aria-label="Pointer mode"
					aria-pressed={pointerMode}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 5,
						border: 0,
						borderRadius: 10,
						padding: "8px 10px",
						color: pointerMode ? "#fff" : "#9aa4b8",
						background: pointerMode ? "#2676ff" : "transparent",
						fontWeight: 600,
						fontSize: 12,
						cursor: "pointer",
					}}
				>
					<CursorIcon size={17} weight={pointerMode ? "fill" : "regular"} />
					Pointer
				</button>
				<span style={{ width: 1, height: 24, background: "rgba(255,255,255,.14)", margin: "0 2px" }} />
				{TOOLS.map(({ value, label, Icon, shortcut }) => (
					<button
						key={value}
						type="button"
						onClick={() => {
							setTool(value);
							setPointerMode(false);
						}}
						title={`${label} (${shortcut})`}
						aria-label={label}
						aria-pressed={!pointerMode && tool === value}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 5,
							border: 0,
							borderRadius: 10,
							padding: "8px 10px",
							color: !pointerMode && tool === value ? "#fff" : "#9aa4b8",
							background: !pointerMode && tool === value ? "#2676ff" : "transparent",
							fontWeight: 600,
							fontSize: 12,
							cursor: "pointer",
							transition: "background 120ms ease, color 120ms ease",
						}}
					>
						<Icon size={17} weight={!pointerMode && tool === value ? "fill" : "regular"} />
						{label}
					</button>
				))}
				<span style={{ width: 1, height: 24, background: "rgba(255,255,255,.14)", margin: "0 2px" }} />
				{COLORS.map((value) => (
					<button
						key={value}
						type="button"
						onClick={() => setColor(value)}
						aria-label={`Use ${value}`}
						aria-pressed={color === value}
						style={{
							width: 22,
							height: 22,
							borderRadius: "50%",
							border: color === value ? "2px solid white" : "2px solid transparent",
							outline: color === value ? "1px solid rgba(0,0,0,.25)" : "none",
							background: value,
							cursor: "pointer",
							padding: 0,
						}}
					/>
				))}
				<span style={{ width: 1, height: 24, background: "rgba(255,255,255,.14)", margin: "0 2px" }} />
				{SIZE_STEPS.map(({ scale, label }) => (
					<button
						key={label}
						type="button"
						onClick={() => setSizeScale(scale)}
						title={`${label} size`}
						aria-label={`${label} size`}
						aria-pressed={sizeScale === scale}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							width: 26,
							height: 26,
							border: 0,
							borderRadius: 8,
							background: sizeScale === scale ? "rgba(255,255,255,.14)" : "transparent",
							cursor: "pointer",
						}}
					>
						<span
							style={{
								width: 5 + scale * 6,
								height: 5 + scale * 6,
								borderRadius: "50%",
								background: sizeScale === scale ? "#fff" : "#9aa4b8",
								display: "block",
							}}
						/>
					</button>
				))}
				<input
					type="range"
					min={25}
					max={100}
					value={Math.round(opacity * 100)}
					onChange={(event) => setOpacity(Number(event.target.value) / 100)}
					title={`Opacity: ${Math.round(opacity * 100)}%`}
					aria-label="Opacity"
					style={{ width: 60, accentColor: color, cursor: "pointer" }}
				/>
				<span style={{ width: 1, height: 24, background: "rgba(255,255,255,.14)", margin: "0 2px" }} />
				<button
					type="button"
					onClick={() => setSpotlightOn((value) => !value)}
					title="Spotlight — dim the screen except around your cursor (S, scroll to resize)"
					aria-label="Spotlight"
					aria-pressed={spotlightOn}
					style={{
						border: 0,
						background: spotlightOn ? "#2676ff" : "transparent",
						color: spotlightOn ? "#fff" : "#d1d5db",
						padding: 8,
						borderRadius: 10,
						cursor: "pointer",
					}}
				>
					<FlashlightIcon size={18} weight={spotlightOn ? "fill" : "regular"} />
				</button>
				<button
					type="button"
					onClick={undoLast}
					title="Undo (Ctrl+Z)"
					aria-label="Undo"
					style={{ border: 0, background: "transparent", color: "#d1d5db", padding: 8, borderRadius: 10, cursor: "pointer" }}
				>
					<ArrowCounterClockwiseIcon size={18} />
				</button>
				<button
					type="button"
					onClick={clearAll}
					title="Clear all"
					aria-label="Clear all"
					style={{ border: 0, background: "transparent", color: "#d1d5db", padding: 8, borderRadius: 10, cursor: "pointer" }}
				>
					<EraserIcon size={18} />
				</button>
				<button
					type="button"
					onClick={() => window.electronAPI?.annotationOverlayClose?.()}
					title="Close (Esc)"
					aria-label="Close"
					style={{ border: 0, background: "transparent", color: "#d1d5db", padding: 8, borderRadius: 10, cursor: "pointer" }}
				>
					<XIcon size={18} />
				</button>
			</div>
			<canvas ref={settledCanvasRef} style={{ position: "absolute", inset: 0, display: "block", zIndex: 0, pointerEvents: "none" }} />
			<canvas
				ref={activeCanvasRef}
				style={{ position: "absolute", inset: 0, display: "block", zIndex: 1, touchAction: "none", cursor, pointerEvents: pointerMode ? "none" : "auto" }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finishActive}
				onPointerCancel={finishActive}
				onWheel={onWheel}
				onContextMenu={(event) => event.preventDefault()}
			/>
			<canvas ref={spotlightCanvasRef} style={{ position: "absolute", inset: 0, display: "block", zIndex: 2, pointerEvents: "none" }} />
			{textEditor && (
				<textarea
					ref={textAreaRef}
					defaultValue=""
					rows={1}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							commitTextEditor();
						} else if (event.key === "Escape") {
							event.preventDefault();
							cancelTextEditor();
						}
					}}
					onBlur={commitTextEditor}
					style={{
						position: "fixed",
						left: textEditor.x,
						top: textEditor.y,
						minWidth: 180,
						maxWidth: 480,
						background: "rgba(15,20,30,.78)",
						color,
						border: `1px solid ${color}`,
						borderRadius: 8,
						padding: "4px 8px",
						font: `700 ${Math.round(TEXT_BASE_FONT_SIZE * sizeScale)}px system-ui, sans-serif`,
						outline: "none",
						resize: "none",
						zIndex: 3,
						caretColor: color,
					}}
				/>
			)}
			<div
				style={{
					position: "fixed",
					bottom: 22,
					left: "50%",
					transform: "translateX(-50%)",
					color: "white",
					font: "600 12px system-ui",
					textShadow: "0 1px 3px #000",
					zIndex: 2,
					pointerEvents: "none",
				}}
			>
				Draw anywhere · marks fade automatically · 1-7 tools · P pointer mode · S spotlight · Ctrl+Z undo · Esc to finish
			</div>
		</div>
	);
}
