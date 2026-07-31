import {
	ArrowCounterClockwiseIcon,
	CircleIcon,
	EraserIcon,
	HighlighterIcon,
	PaintBrushIcon,
	PencilSimpleIcon,
	RectangleIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FreehandTool = "pencil" | "brush" | "highlighter";
type ShapeTool = "circle" | "rectangle";
type Tool = FreehandTool | ShapeTool;
type Point = { x: number; y: number; t: number };

type StrokeMark = {
	kind: "stroke";
	id: number;
	tool: FreehandTool;
	color: string;
	points: Point[];
	widths: number[];
	settledAt: number;
};
type ShapeMark = {
	kind: "shape";
	id: number;
	tool: ShapeTool;
	color: string;
	start: Point;
	end: Point;
	square: boolean;
	settledAt: number;
};
type Mark = StrokeMark | ShapeMark;

const COLORS = ["#ff3b5c", "#ffbd2e", "#35d07f", "#41a3ff", "#f8fafc"];
const TOOLS: { value: Tool; label: string; Icon: typeof PencilSimpleIcon; shortcut: string }[] = [
	{ value: "pencil", label: "Pencil", Icon: PencilSimpleIcon, shortcut: "1" },
	{ value: "brush", label: "Brush", Icon: PaintBrushIcon, shortcut: "2" },
	{ value: "highlighter", label: "Highlighter", Icon: HighlighterIcon, shortcut: "3" },
	{ value: "circle", label: "Circle", Icon: CircleIcon, shortcut: "4" },
	{ value: "rectangle", label: "Box", Icon: RectangleIcon, shortcut: "5" },
];

const HOLD_MS = 850;
const FADE_MS = 650;
const SHAPE_LINE_WIDTH = 3.5;
const IDLE_PASSTHROUGH_MS = 1400;

const STROKE_WIDTH: Record<FreehandTool, { base: number; min: number; taper: number }> = {
	pencil: { base: 3, min: 1.75, taper: 1.25 },
	brush: { base: 12, min: 4.5, taper: 8.5 },
	highlighter: { base: 22, min: 22, taper: 0 },
};

function isFreehand(tool: Tool): tool is FreehandTool {
	return tool === "pencil" || tool === "brush" || tool === "highlighter";
}

function widthFor(tool: FreehandTool, prev: Point, next: Point, pressure: number, pointerType: string): number {
	const cfg = STROKE_WIDTH[tool];
	if (tool === "highlighter") return cfg.base;
	const dt = Math.max(1, next.t - prev.t);
	const dist = Math.hypot(next.x - prev.x, next.y - prev.y);
	const speedFactor = Math.min(1, dist / dt / 1.6);
	let width = cfg.base - cfg.taper * speedFactor;
	if (pointerType === "pen" && pressure > 0) {
		width *= 0.55 + pressure * 0.9;
	}
	return Math.max(cfg.min, Math.min(cfg.base * 1.15, width));
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

function paintShape(ctx: CanvasRenderingContext2D, mark: Pick<ShapeMark, "tool" | "color" | "start" | "end" | "square">) {
	const { start, tool, color, square } = mark;
	let end = mark.end;
	if (square) {
		const size = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
		end = {
			x: start.x + Math.sign(end.x - start.x || 1) * size,
			y: start.y + Math.sign(end.y - start.y || 1) * size,
			t: end.t,
		};
	}
	ctx.strokeStyle = color;
	ctx.lineWidth = SHAPE_LINE_WIDTH;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
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

function paintMark(ctx: CanvasRenderingContext2D, mark: Mark, opacity: number) {
	ctx.save();
	if (mark.kind === "stroke") {
		if (mark.tool === "highlighter") {
			ctx.globalCompositeOperation = "multiply";
			ctx.globalAlpha = 0.5 * opacity;
		} else {
			ctx.globalAlpha = opacity;
		}
		paintStrokePath(ctx, mark.color, mark.points, mark.widths);
	} else {
		ctx.globalAlpha = opacity;
		paintShape(ctx, mark);
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

	const settledCanvasRef = useRef<HTMLCanvasElement>(null);
	const activeCanvasRef = useRef<HTMLCanvasElement>(null);
	const sizeRef = useRef({ width: 0, height: 0 });
	const marksRef = useRef<Mark[]>([]);
	const nextIdRef = useRef(0);
	const fadeFrameRef = useRef<number | null>(null);

	const strokeStateRef = useRef<{
		tool: FreehandTool;
		color: string;
		points: Point[];
		widths: number[];
		lastMid: Point;
		prevRaw: Point;
	} | null>(null);
	const shapeStateRef = useRef<{ tool: ShapeTool; color: string; start: Point; end: Point; square: boolean } | null>(
		null,
	);

	const ignoringMouseRef = useRef(false);
	const idleTimerRef = useRef<number | null>(null);

	const setIgnoringMouse = useCallback((ignore: boolean) => {
		if (ignoringMouseRef.current === ignore) return;
		ignoringMouseRef.current = ignore;
		window.electronAPI?.annotationOverlaySetIgnoreMouse?.(ignore);
	}, []);

	const scheduleIdlePassthrough = useCallback(() => {
		if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
		idleTimerRef.current = window.setTimeout(() => {
			idleTimerRef.current = null;
			if (!strokeStateRef.current && !shapeStateRef.current) setIgnoringMouse(true);
		}, IDLE_PASSTHROUGH_MS);
	}, [setIgnoringMouse]);

	const wakeFromPassthrough = useCallback(() => {
		setIgnoringMouse(false);
		scheduleIdlePassthrough();
	}, [scheduleIdlePassthrough, setIgnoringMouse]);

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
			const opacity = age <= HOLD_MS ? 1 : 1 - (age - HOLD_MS) / FADE_MS;
			paintMark(ctx, mark, opacity);
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
		const canvas = activeCanvasRef.current;
		const ctx = canvas?.getContext("2d");
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
				square: shape.square,
				settledAt: performance.now(),
			});
		}
		scheduleIdlePassthrough();
	}, [clearActiveCanvas, commitMark, scheduleIdlePassthrough]);

	const cancelActive = useCallback(() => {
		strokeStateRef.current = null;
		shapeStateRef.current = null;
		clearActiveCanvas();
		scheduleIdlePassthrough();
	}, [clearActiveCanvas, scheduleIdlePassthrough]);

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
			const match = TOOLS.find((entry) => entry.shortcut === event.key);
			if (match) setTool(match.value);
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
			for (const ref of [settledCanvasRef, activeCanvasRef]) {
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
		};
		setupCanvases();
		window.addEventListener("resize", setupCanvases);
		return () => window.removeEventListener("resize", setupCanvases);
	}, [cancelActive]);

	useEffect(() => {
		return () => {
			if (fadeFrameRef.current !== null) cancelAnimationFrame(fadeFrameRef.current);
			if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
		};
	}, []);

	const pointFor = (clientX: number, clientY: number, rect: DOMRect): Point => ({
		x: clientX - rect.left,
		y: clientY - rect.top,
		t: performance.now(),
	});

	const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
		if (event.button !== 0) return;
		wakeFromPassthrough();
		event.currentTarget.setPointerCapture(event.pointerId);
		const rect = event.currentTarget.getBoundingClientRect();
		const point = pointFor(event.clientX, event.clientY, rect);
		if (isFreehand(tool)) {
			strokeStateRef.current = {
				tool,
				color,
				points: [point],
				widths: [widthFor(tool, point, point, event.pressure, event.pointerType)],
				lastMid: point,
				prevRaw: point,
			};
		} else {
			shapeStateRef.current = { tool, color, start: point, end: point, square: event.shiftKey };
		}
	};

	const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
		wakeFromPassthrough();
		const stroke = strokeStateRef.current;
		const shape = shapeStateRef.current;
		if (!stroke && !shape) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];

		if (stroke) {
			const ctx = activeCanvasRef.current?.getContext("2d");
			for (const sample of samples) {
				const point = pointFor(sample.clientX, sample.clientY, rect);
				const width = widthFor(stroke.tool, stroke.prevRaw, point, event.pressure, event.pointerType);
				stroke.points.push(point);
				stroke.widths.push(width);
				const mid: Point = { x: (stroke.prevRaw.x + point.x) / 2, y: (stroke.prevRaw.y + point.y) / 2, t: point.t };
				if (ctx) {
					ctx.save();
					ctx.strokeStyle = stroke.color;
					ctx.lineCap = "round";
					ctx.lineJoin = "round";
					ctx.lineWidth = width;
					if (stroke.tool === "highlighter") {
						ctx.globalCompositeOperation = "multiply";
						ctx.globalAlpha = 0.5;
					}
					ctx.beginPath();
					ctx.moveTo(stroke.lastMid.x, stroke.lastMid.y);
					ctx.quadraticCurveTo(stroke.prevRaw.x, stroke.prevRaw.y, mid.x, mid.y);
					ctx.stroke();
					ctx.restore();
				}
				stroke.lastMid = mid;
				stroke.prevRaw = point;
			}
			return;
		}

		if (shape) {
			const last = samples[samples.length - 1];
			shape.end = pointFor(last.clientX, last.clientY, rect);
			shape.square = event.shiftKey;
			clearActiveCanvas();
			const ctx = activeCanvasRef.current?.getContext("2d");
			if (ctx) paintShape(ctx, shape);
		}
	};

	const cursor = useMemo(() => {
		if (!isFreehand(tool)) return "crosshair";
		return buildCursor(color, STROKE_WIDTH[tool].base);
	}, [tool, color]);

	return (
		<div style={{ width: "100vw", height: "100vh", userSelect: "none" }} onMouseMove={wakeFromPassthrough}>
			<div
				style={{
					position: "fixed",
					top: 20,
					left: "50%",
					transform: "translateX(-50%)",
					display: "flex",
					alignItems: "center",
					gap: 6,
					padding: 8,
					borderRadius: 16,
					background: "rgba(15, 20, 30, .82)",
					backdropFilter: "blur(14px)",
					color: "white",
					boxShadow: "0 12px 36px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.06)",
					zIndex: 2,
				}}
			>
				{TOOLS.map(({ value, label, Icon, shortcut }) => (
					<button
						key={value}
						type="button"
						onClick={() => setTool(value)}
						title={`${label} (${shortcut})`}
						aria-label={label}
						aria-pressed={tool === value}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 5,
							border: 0,
							borderRadius: 10,
							padding: "8px 10px",
							color: tool === value ? "#fff" : "#9aa4b8",
							background: tool === value ? "#2676ff" : "transparent",
							fontWeight: 600,
							fontSize: 12,
							cursor: "pointer",
							transition: "background 120ms ease, color 120ms ease",
						}}
					>
						<Icon size={17} weight={tool === value ? "fill" : "regular"} />
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
			<canvas ref={settledCanvasRef} style={{ position: "absolute", inset: 0, display: "block", pointerEvents: "none" }} />
			<canvas
				ref={activeCanvasRef}
				style={{ position: "absolute", inset: 0, display: "block", touchAction: "none", cursor }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={finishActive}
				onPointerCancel={finishActive}
				onContextMenu={(event) => event.preventDefault()}
			/>
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
				Draw anywhere · marks fade automatically · 1-5 tools · Ctrl+Z undo · Esc to finish
			</div>
		</div>
	);
}
