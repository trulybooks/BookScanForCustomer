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

		// 從單書頁按上一頁回來時，bfcache 還原的 video 元素已經沒有串流了，
		// 得重新啟動相機。persisted 為 false 的一般載入由 constructor 負責。
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
	 * 在同一個分頁導向單書頁。
	 *
	 * 刻意用 location.assign 而不是 window.open：條碼解碼的 callback 不算使用者
	 * 手勢，瀏覽器（iOS Safari 尤其）會把 window.open 當成彈出視窗擋掉，使用者會
	 * 看到一則攔截警告、還得多點一次才進得去。同頁導向不受彈出視窗封鎖限制，
	 * 一定成功、也就沒有警告可言。代價是要按上一頁才能掃下一本。
	 */
	private openBookPage(code: string): void {
		this.setLastOpenedCode(code);
		this.showResult(code);

		// 先關相機再離開，讓鏡頭與錄影指示燈乾淨地釋放，不要留給瀏覽器收尾
		this.scannerService.stopScanner();

		// 離開前先替掃描器多推一筆歷史條目。
		//
		// WebKit（iOS Safari）會把「載入後沒有使用者操作就自動導走」當成 client
		// redirect，用 replace 取代當前的歷史條目而不是往後推一筆——掃描器那一筆
		// 就這樣被書頁吃掉，使用者按上一頁會直接跳到更前面的頁面，回不到掃描器。
		// 條碼是相機自己解出來的，永遠不算使用者手勢，所以一定會踩到這個啟發式。
		//
		// 多推一筆之後兩種語意都安全：被 replace 就吃掉這筆多的、原本那筆還在；
		// 正常 push 則是多一筆相同網址的掃描器頁。不論哪種，按一次上一頁都會回到
		// 掃描器。桌機 Chrome 實測一律是 push，加了這行也不會變差。
		try {
			history.pushState(null, '', location.href);
		} catch {
			/* pushState 失敗不該擋住導向，最差就是回到修正前的行為 */
		}

		location.assign(`${BOOK_PAGE_BASE}${code}/`);
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
