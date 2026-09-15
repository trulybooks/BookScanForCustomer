import { ScannerService } from './scanner.js';
import { UIUtils } from './utils.js';

/**
 * 掃到的條碼直接對應官網的單書頁：
 *   https://trulybookstore.in-common.tw/books/book-<條碼>/
 * 不加 index.html 也會回 200。條碼是唯一的 key——系列書的每一冊都有自己的
 * book- 頁，所以不需要另外處理系列。
 */
const BOOK_PAGE_BASE = 'https://trulybookstore.in-common.tw/books/book-';

/**
 * 上一本掃到的條碼，純粹用來在返回後把「上次掃描」那張卡片顯示出來。
 * 這不是重複掃描的抑制——掃到什麼就開什麼，同一本也可以一直重掃。
 *
 * 存在 sessionStorage 而不是只放記憶體：回上一頁不一定走 bfcache（頁面用過
 * getUserMedia 時常常不符合 bfcache 條件），整頁重新載入記憶體裡的值就沒了。
 * sessionStorage 只活在這個分頁、關掉就消失，不是在存使用者資料。
 */
const LAST_CODE_KEY = 'bookScan_lastOpenedCode';

class BookScanApp {
	private scannerService = new ScannerService();
	private overlayOpen = false;

	/**
	 * 目前是否還留著一筆「給返回鍵吃」的歷史條目。
	 * 只有 popstate（＝條目真的被瀏覽器彈掉了）會把它清成 false。
	 */
	private pushedHistory = false;

	constructor() {
		this.setupEventListeners();

		// 回到本頁時把上一本顯示出來，方便確認剛才掃到什麼、或再開一次
		const previous = this.getLastOpenedCode();
		if (previous) this.showResult(previous);

		this.startScanning();
	}

	private getLastOpenedCode(): string | null {
		try {
			return sessionStorage.getItem(LAST_CODE_KEY);
		} catch {
			// Safari 無痕模式等情況會直接丟例外，當作沒有記錄即可
			return null;
		}
	}

	private setLastOpenedCode(code: string): void {
		try {
			sessionStorage.setItem(LAST_CODE_KEY, code);
		} catch {
			/* 存不了就算了，只影響「上次掃描」卡片，不影響掃描與導向 */
		}
	}

	private setupEventListeners(): void {
		document.getElementById('btn-start-camera')?.addEventListener('click', () => {
			this.startScanning();
		});

		// 手動輸入：條碼刮花或掃不到時的備案
		document.getElementById('btn-manual')?.addEventListener('click', () => {
			UIUtils.showModal('modal-manual');
			(document.getElementById('input-isbn') as HTMLInputElement)?.focus();
		});

		document.getElementById('btn-cancel-manual')?.addEventListener('click', () => {
			UIUtils.hideModal('modal-manual');
		});

		document.getElementById('btn-open-manual')?.addEventListener('click', () => {
			this.handleManualSubmit();
		});

		document.getElementById('input-isbn')?.addEventListener('keypress', (e) => {
			if ((e as KeyboardEvent).key === 'Enter') this.handleManualSubmit();
		});

		document.getElementById('btn-close-book')?.addEventListener('click', () => {
			this.closeOverlay();
		});

		// 點遮罩也能關，跟官網其他 modal 一致（點卡片本身不會關）
		document.getElementById('book-overlay')?.addEventListener('click', (e) => {
			if (e.target === e.currentTarget) this.closeOverlay();
		});

		// 「上次掃描」的連結也走疊層。放任它同頁導向的話，就又把先前那些
		// 歷史條目與彈出視窗的問題帶回來了。
		document.getElementById('scan-result-link')?.addEventListener('click', (e) => {
			e.preventDefault();
			const code = document.getElementById('scan-result-code')?.textContent?.trim();
			if (code) this.openBookPage(code);
		});

		// 手機的實體／手勢返回鍵：關閉疊層，而不是離開整個 app。
		// 這時候那筆歷史條目已經被瀏覽器彈掉了，closeOverlay 不可以再 back 一次。
		window.addEventListener('popstate', () => {
			this.pushedHistory = false;
			this.closeOverlay();
		});

		// bfcache 還原的 video 元素已經沒有串流了，得重新啟動相機。
		// persisted 為 false 的一般載入由 constructor 負責。
		window.addEventListener('pageshow', (e) => {
			if ((e as PageTransitionEvent).persisted) this.startScanning();
		});

		// 開新分頁會讓本頁退到背景。相機留著只是耗電、而且錄影指示燈一直亮著，
		// 所以切走就關掉，切回來再開。
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				this.scannerService.stopScanner();
			} else {
				this.startScanning();
				// 疊層還開著就讓它維持暫停，不要在書頁後面偷偷繼續解碼
				if (this.overlayOpen) this.scannerService.pauseScanning();
			}
		});
	}

	/** 啟動相機。失敗時退回一顆手動啟動的按鈕（iOS 有時會擋掉自動 play）。 */
	private async startScanning(): Promise<void> {
		if (this.scannerService.isRunning()) return;

		const startBtn = document.getElementById('btn-start-camera');
		this.setStatus('正在開啟相機…');

		try {
			await this.scannerService.startScanner('reader', (code) => this.handleScannedCode(code));
			startBtn?.classList.add('hidden');
			this.setStatus('將鏡頭對準書背的條碼');
		} catch (error) {
			console.error(error);
			this.setStatus((error as Error).message);
			startBtn?.classList.remove('hidden');
		}
	}

	/**
	 * 掃到什麼就開什麼——不比對條碼內容、同一本也可以一直重掃。
	 * 「返回後不要立刻又被導走」是由 ScannerService 的 armed 機制處理的
	 * （要先看到一幀沒有條碼），跟條碼是什麼無關。
	 */
	private handleScannedCode(code: string): void {
		this.openBookPage(code.replace(/[-\s]/g, ''));
	}

	private handleManualSubmit(): void {
		const input = document.getElementById('input-isbn') as HTMLInputElement;
		const cleaned = input?.value.replace(/[-\s]/g, '') ?? '';

		if (!/^\d{13}$/.test(cleaned) && !/^\d{9}[\dX]$/i.test(cleaned)) {
			UIUtils.showToast('請輸入 10 或 13 位數的 ISBN');
			return;
		}

		UIUtils.hideModal('modal-manual');
		this.openBookPage(cleaned);
	}

	/**
	 * 在原地用 iframe 疊層顯示單書頁，完全不離開這一頁。
	 *
	 * 先前試過另開分頁和同頁導向，兩條路都被瀏覽器的行為擋掉：解碼 callback 不算
	 * 使用者手勢，window.open 會被當成彈出視窗攔截；改成 location.assign 之後，
	 * WebKit 又把「載入後沒有手勢就自動導走」當成 client redirect，用 replace 吃掉
	 * 掃描器的歷史條目，按上一頁會跳到更前面的頁面。疊層沒有導向，這兩類問題都不存在，
	 * 而且相機不用關，關掉疊層可以馬上掃下一本。官網的單書頁沒有 X-Frame-Options
	 * 也沒有 CSP frame-ancestors，所以可以嵌入。
	 */
	private openBookPage(code: string): void {
		const url = `${BOOK_PAGE_BASE}${code}/`;

		this.setLastOpenedCode(code);
		this.showResult(code);

		const external = document.getElementById('book-overlay-external') as HTMLAnchorElement | null;
		const overlay = document.getElementById('book-overlay');
		if (!overlay) return;

		this.mountFrame(url);
		if (external) external.href = url;
		overlay.classList.remove('hidden');
		this.overlayOpen = true;

		// 疊層後面不要繼續解碼，但相機留著——關掉疊層要能立刻接著掃
		this.scannerService.pauseScanning();

		// 推一筆歷史條目，讓手機的上一頁變成「關閉疊層」而不是離開整個 app。
		// 用 ✕ 或遮罩關掉時不會回收這筆條目（回收會弄壞返回鍵，見 closeOverlay），
		// 所以這裡先確認還沒有一筆在手上，避免每開一本就疊一筆、要按很多次才離得開。
		if (!this.pushedHistory) {
			try {
				history.pushState({ bookOverlay: true }, '', location.href);
				this.pushedHistory = true;
			} catch {
				/* 推不了就只剩 ✕ 與遮罩可以關，不影響主要流程 */
				this.pushedHistory = false;
			}
		}
	}

	/**
	 * 關閉疊層並恢復掃描。可以重複呼叫。
	 *
	 * ✕ 會直接呼叫這裡把畫面關掉，不透過 history.back()。先前是走 history 讓 ✕ 與
	 * 返回鍵共用一條路徑，但在實機上 popstate 沒有如期送達，結果只有 iframe 被清空、
	 * 卡片還留在畫面上。關閉是使用者每掃一本都要做的動作，不能仰賴某個事件一定會來。
	 */
	private closeOverlay(): void {
		if (!this.overlayOpen) return;
		this.overlayOpen = false;

		document.getElementById('book-overlay')?.classList.add('hidden');
		this.unmountFrame();

		this.scannerService.resumeScanning();

		// 刻意不在這裡呼叫 history.back() 去回收那筆條目。試過，結果是緊接著的
		// pushState 與那個非同步的 back 互相打架，返回鍵就再也關不掉疊層了。
		// 條目留著沒關係——下面的 openBookPage 不會重複推，所以最多只會有一筆。
	}

	/**
	 * 每次都建立一個全新的 iframe，關閉時整個移除。
	 *
	 * 不用「換 src」的原因：iframe 的每一次導覽都會在瀏覽歷史裡多加一筆，開啟一筆、
	 * 關閉設回 about:blank 又一筆。返回鍵於是變成先倒退 iframe 的導覽，按了不會關掉
	 * 疊層。把元素整個移除，它的歷史紀錄會跟著消失；而新建 iframe 的第一次載入
	 * 不會產生條目，所以歷史裡永遠只有我們自己推的那一筆。
	 * 移除同時也讓書頁停止運作、釋放記憶體。
	 */
	private mountFrame(url: string): void {
		const slot = document.getElementById('book-frame-slot');
		if (!slot) return;

		slot.replaceChildren();

		const frame = document.createElement('iframe');
		frame.id = 'book-frame';
		frame.className = 'book-overlay-frame';
		frame.title = '單書頁';
		frame.src = url;
		slot.appendChild(frame);
	}

	private unmountFrame(): void {
		document.getElementById('book-frame-slot')?.replaceChildren();
	}

	/** 顯示上一本掃到的書，方便確認剛才掃到什麼、或不用再掃一次就重開。 */
	private showResult(code: string): void {
		const result = document.getElementById('scan-result');
		const link = document.getElementById('scan-result-link') as HTMLAnchorElement | null;
		const codeEl = document.getElementById('scan-result-code');

		if (!result || !link || !codeEl) return;

		codeEl.textContent = code;
		link.href = `${BOOK_PAGE_BASE}${code}/`;
		result.classList.remove('hidden');
	}

	private setStatus(message: string): void {
		const status = document.getElementById('scanner-status');
		if (status) status.textContent = message;
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => new BookScanApp());
} else {
	new BookScanApp();
}
