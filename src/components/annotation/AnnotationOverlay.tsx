import { CircleIcon, EraserIcon, PencilSimpleLineIcon, RectangleIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

type Tool = "pencil" | "brush" | "highlighter" | "circle" | "rectangle";
type Point = { x: number; y: number };
type Mark = { id: number; tool: Tool; color: string; points: Point[] };

const COLORS = ["#ff3b5c", "#ffbd2e", "#35d07f", "#41a3ff"];
const FADE_AFTER_MS = 2200;

function drawHandDrawnCircle(ctx: CanvasRenderingContext2D, start: Point, end: Point) {
	const cx = (start.x + end.x) / 2;
	const cy = (start.y + end.y) / 2;
	const rx = Math.max(12, Math.abs(end.x - start.x) / 2);
	const ry = Math.max(12, Math.abs(end.y - start.y) / 2);
	// A deliberately open, asymmetric loop gives the same smooth marker feel as
	// a presenter circling an element by hand instead of a perfect SVG ellipse.
	ctx.moveTo(cx - rx * 0.76, cy - ry * 0.68);
	ctx.bezierCurveTo(cx - rx * 0.18, cy - ry * 1.15, cx + rx * 0.64, cy - ry * 1.02, cx + rx * 0.94, cy - ry * 0.28);
	ctx.bezierCurveTo(cx + rx * 1.08, cy + ry * 0.38, cx + rx * 0.34, cy + ry * 1.1, cx - rx * 0.49, cy + ry * 0.94);
	ctx.bezierCurveTo(cx - rx * 1.05, cy + ry * 0.67, cx - rx * 1.13, cy - ry * 0.23, cx - rx * 0.76, cy - ry * 0.68);
}

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark) {
	const [start, end = start] = mark.points;
	ctx.beginPath();
	ctx.strokeStyle = mark.color;
	ctx.globalAlpha = mark.tool === "highlighter" ? 0.32 : 1;
	ctx.lineWidth = mark.tool === "pencil" ? 3 : mark.tool === "highlighter" ? 20 : 8;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	if (mark.tool === "pencil" || mark.tool === "brush" || mark.tool === "highlighter") {
		ctx.moveTo(start.x, start.y);
		for (let index = 1; index < mark.points.length - 1; index += 1) {
			const point = mark.points[index];
			const next = mark.points[index + 1];
			ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
		}
		ctx.lineTo(end.x, end.y);
	} else if (mark.tool === "rectangle") {
		ctx.roundRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y), 8);
	} else {
		drawHandDrawnCircle(ctx, start, end);
	}
	ctx.stroke();
	ctx.globalAlpha = 1;
}

export function AnnotationOverlay() {
	const [tool, setTool] = useState<Tool>("brush");
	const [color, setColor] = useState(COLORS[0]);
	const [marks, setMarks] = useState<Mark[]>([]);
	const activeMark = useRef<Mark | null>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const paintFrame = useRef<number | null>(null);

	const removeMark = useCallback((id: number) => {
		setMarks((current) => current.filter((mark) => mark.id !== id));
	}, []);

	const finishMark = useCallback(() => {
		const mark = activeMark.current;
		if (!mark) return;
		activeMark.current = null;
		setMarks((current) => [...current, mark]);
		window.setTimeout(() => {
			removeMark(mark.id);
		}, FADE_AFTER_MS);
	}, [removeMark]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") window.electronAPI?.annotationOverlayClose?.();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.round(window.innerWidth * ratio);
		canvas.height = Math.round(window.innerHeight * ratio);
		canvas.style.width = `${window.innerWidth}px`;
		canvas.style.height = `${window.innerHeight}px`;
		const context = canvas.getContext("2d");
		if (!context) return;
		context.scale(ratio, ratio);
		marks.forEach((mark) => drawMark(context, mark));
		if (activeMark.current) drawMark(context, activeMark.current);
	}, [marks]);

	const pointFor = (clientX: number, clientY: number, rect: DOMRect): Point => {
		return { x: clientX - rect.left, y: clientY - rect.top };
	};
	const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const rect = event.currentTarget.getBoundingClientRect();
		activeMark.current = { id: Date.now(), tool, color, points: [pointFor(event.clientX, event.clientY, rect)] };
	};
	const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
		if (!activeMark.current) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
		for (const sample of samples) activeMark.current.points.push(pointFor(sample.clientX, sample.clientY, rect));
		if (paintFrame.current !== null) return;
		paintFrame.current = requestAnimationFrame(() => {
			paintFrame.current = null;
			setMarks((current) => [...current]);
		});
	};

	return (
		<div style={{ width: "100vw", height: "100vh", cursor: "crosshair", userSelect: "none" }}>
			<div style={{ position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 8, padding: 8, borderRadius: 14, background: "rgba(17, 24, 39, .92)", color: "white", boxShadow: "0 10px 32px rgba(0,0,0,.35)", zIndex: 2 }}>
				{([ ["pencil", "Pencil", PencilSimpleLineIcon], ["brush", "Brush", PencilSimpleLineIcon], ["highlighter", "Highlight", PencilSimpleLineIcon], ["circle", "Circle", CircleIcon], ["rectangle", "Box", RectangleIcon] ] as const).map(([value, label, Icon]) => <button key={value} type="button" onClick={() => setTool(value)} title={label} style={{ display: "flex", alignItems: "center", gap: 5, border: 0, borderRadius: 8, padding: "7px 9px", color: tool === value ? "#fff" : "#aab3c2", background: tool === value ? "#2676ff" : "transparent", fontWeight: 700, fontSize: 12 }}><Icon size={17} />{label}</button>)}
				<span style={{ width: 1, height: 24, background: "#475569" }} />
				{COLORS.map((value) => <button key={value} type="button" onClick={() => setColor(value)} aria-label={`Use ${value}`} style={{ width: 20, height: 20, borderRadius: "50%", border: color === value ? "2px solid white" : "2px solid transparent", background: value }} />)}
				<button type="button" onClick={() => setMarks([])} title="Clear" style={{ border: 0, background: "transparent", color: "#d1d5db", padding: 7 }}><EraserIcon size={18} /></button>
				<button type="button" onClick={() => window.electronAPI?.annotationOverlayClose?.()} title="Close (Esc)" style={{ border: 0, background: "transparent", color: "#d1d5db", padding: 7 }}><XIcon size={18} /></button>
			</div>
			<canvas ref={canvasRef} style={{ display: "block", touchAction: "none" }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finishMark} onPointerCancel={finishMark} />
			<div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", color: "white", font: "600 12px system-ui", textShadow: "0 1px 3px #000" }}>Draw as many marks as you need · each fades automatically · Esc when you are done</div>
		</div>
	);
}
