import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';

// Serve the wasm binary from our own dist/ (copied there by the build script)
// instead of the default CDN, so scanning works without third-party fetches.
// The path is resolved against the document URL, which works both locally and
// under the /BookScan/ GitHub Pages base path.
prepareZXingModule({
	overrides: {
		locateFile: (path: string, prefix: string) =>
			path.endsWith('.wasm') ? `dist/${path}` : prefix + path
	}
});

const READER_OPTIONS: ReaderOptions = {
	formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128'],
	tryHarder: true
};

// Central region of the camera frame that gets cropped out and decoded,
// as fractions of the frame size. Cropping before decoding is essential:
// zxing fails on a full frame where the barcode is a small part of a busy
// scene, but succeeds on the same pixels cropped to just the barcode area
// (verified against real photos). Wide and short to match EAN-13 geometry.
const SCAN_REGION = { width: 0.9, height: 0.4 };

const SCAN_INTERVAL_MS = 120;

/**
 * Service for scanning ISBN barcodes from the device camera.
 *
 * Pipeline: getUserMedia video stream → crop the central scan region of each
 * frame into a canvas → decode with zxing-wasm (zxing-cpp compiled to
 * WebAssembly, much stronger at 1D barcodes than JS decoders, and the same
 * on every platform — no reliance on the flaky iOS native BarcodeDetector).
 */
export class ScannerService {
	private stream: MediaStream | null = null;
	private videoEl: HTMLVideoElement | null = null;
	private containerEl: HTMLElement | null = null;
	private scanTimer: ReturnType<typeof setTimeout> | null = null;
	private isScanning: boolean = false;

	/**
	 * 要先看到「畫面中沒有條碼」的一幀，才會回報下一次掃到的結果。
	 *
	 * 這是為了同頁導向的返回流程：從單書頁按上一頁回來時相機會重新啟動，若鏡頭
	 * 還對著剛才那本書，會立刻又解碼成功、又把整頁導走——使用者看到的是「上一頁
	 * 按了沒用」。要求中間至少有一幀是空的，等於要求鏡頭真的離開過書本，
	 * 返回後就會穩穩停在掃描器上。
	 *
	 * 刻意不是「記住上一個條碼、相同就略過」：很多書在 ISBN 旁邊還印了第二個
	 * 條碼（例如 471… 開頭的內部碼），兩個碼會交替被讀到，依條碼比對的做法完全
	 * 擋不住。而且那種做法會讓同一本書沒辦法再掃一次；這裡不限制內容，
	 * 鏡頭移開再回來就能重掃同一本。
	 */
	private armed: boolean = false;

	/**
	 * Initialize the scanner
	 */
	async startScanner(
		elementId: string,
		onSuccess: (decodedText: string) => void,
		onError?: (error: string) => void
	): Promise<void> {
		if (this.isScanning) {
			throw new Error('Scanner is already running');
		}

		const container = document.getElementById(elementId);
		if (!container) {
			throw new Error(`Scanner container #${elementId} not found`);
		}

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: {
					facingMode: 'environment',
					width: { ideal: 1920 },
					height: { ideal: 1080 }
				}
			});
		} catch (error) {
			console.error('Error starting scanner:', error);
			throw new Error('Failed to start camera. Please grant camera permissions.');
		}

		// Wrapper keeps the scan-box overlay aligned with the video regardless
		// of the container's own size.
		const wrapper = document.createElement('div');
		wrapper.style.position = 'relative';
		wrapper.style.width = '100%';

		const video = document.createElement('video');
		// playsinline is required on iOS or the video hijacks the whole screen
		video.setAttribute('playsinline', '');
		video.muted = true;
		video.srcObject = this.stream;
		video.style.display = 'block';
		video.style.width = '100%';
		wrapper.appendChild(video);

		const overlay = document.createElement('div');
		overlay.style.position = 'absolute';
		overlay.style.left = `${((1 - SCAN_REGION.width) / 2) * 100}%`;
		overlay.style.top = `${((1 - SCAN_REGION.height) / 2) * 100}%`;
		overlay.style.width = `${SCAN_REGION.width * 100}%`;
		overlay.style.height = `${SCAN_REGION.height * 100}%`;
		overlay.style.border = '3px solid rgba(255, 255, 255, 0.9)';
		overlay.style.borderRadius = '8px';
		overlay.style.boxShadow = '0 0 0 4000px rgba(0, 0, 0, 0.35)';
		overlay.style.pointerEvents = 'none';
		wrapper.appendChild(overlay);

		container.innerHTML = '';
		container.appendChild(wrapper);

		this.containerEl = container;
		this.videoEl = video;

		try {
			await video.play();
		} catch (error) {
			console.error('Error playing camera stream:', error);
			this.cleanup();
			throw new Error('Failed to start camera. Please grant camera permissions.');
		}

		this.isScanning = true;
		this.armed = false;

		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d', { willReadFrequently: true });

		const scanFrame = async (): Promise<void> => {
			if (!this.isScanning || !this.videoEl || !ctx) return;

			if (this.videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.videoEl.videoWidth > 0) {
				const vw = this.videoEl.videoWidth;
				const vh = this.videoEl.videoHeight;
				const cw = Math.floor(vw * SCAN_REGION.width);
				const ch = Math.floor(vh * SCAN_REGION.height);
				const cx = Math.floor((vw - cw) / 2);
				const cy = Math.floor((vh - ch) / 2);

				canvas.width = cw;
				canvas.height = ch;
				ctx.drawImage(this.videoEl, cx, cy, cw, ch, 0, 0, cw, ch);

				try {
					const results = await readBarcodes(ctx.getImageData(0, 0, cw, ch), READER_OPTIONS);

					let found: string | null = null;
					for (const result of results) {
						if (result.isValid && this.isValidISBN(result.text)) {
							found = result.text;
							break;
						}
					}

					if (!found) {
						// 看到乾淨的一幀就重新上膛
						this.armed = true;
					} else if (this.armed) {
						this.armed = false;
						onSuccess(found);
						return;
					}
				} catch (error) {
					// Real decode-infrastructure errors only — "no barcode in
					// frame" is an empty result, not an exception.
					console.warn('Scan error:', error);
					onError?.(String(error));
				}
			}

			this.scanTimer = setTimeout(scanFrame, SCAN_INTERVAL_MS);
		};

		scanFrame();
	}

	/**
	 * Stop the scanner
	 */
	async stopScanner(): Promise<void> {
		if (!this.isScanning) {
			return;
		}
		this.cleanup();
	}

	/**
	 * Check if scanner is currently running
	 */
	isRunning(): boolean {
		return this.isScanning;
	}

	private cleanup(): void {
		this.isScanning = false;

		if (this.scanTimer !== null) {
			clearTimeout(this.scanTimer);
			this.scanTimer = null;
		}

		if (this.stream) {
			this.stream.getTracks().forEach(track => track.stop());
			this.stream = null;
		}

		if (this.containerEl) {
			this.containerEl.innerHTML = '';
			this.containerEl = null;
		}
		this.videoEl = null;
	}

	/**
	 * Validate if the scanned code is a valid ISBN/EAN-13
	 */
	private isValidISBN(code: string): boolean {
		// Remove any hyphens or spaces
		const cleanCode = code.replace(/[-\s]/g, '');

		// Check if it's 13 digits (EAN-13/ISBN-13) or 10 digits (ISBN-10)
		return /^\d{13}$/.test(cleanCode) || /^\d{9}[0-9X]$/i.test(cleanCode);
	}
}
