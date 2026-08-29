import { ScannerService } from './scanner.js';
import { UIUtils } from './utils.js';

/**
 * 掃到的條碼直接對應官網的單書頁：
 *   https://trulybookstore.in-common.tw/books/book-<條碼>/
 * 不加 index.html 也會回 200。條碼是唯一的 key——系列書的每一冊都有自己的
 * book- 頁，所以不需要另外處理系列。
 */
const BOOK_PAGE_BASE = 'https://trulybookstore.in-common.tw/books/book-';

class BookScanApp {
	private scannerService = new ScannerService();

	/**
	 * 最後一次開啟的條碼。相機在回到本頁時會重新啟動，若鏡頭還對著同一本書會
	 * 立刻再解碼一次、又開一個分頁。記住上一本並略過相同的條碼，換一本才會再觸發。
	 */
	private lastOpenedCode: string | null = null;

	constructor() {
		this.setupEventListeners();
		this.startScanning();
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

	/** 掃到條碼：開啟對應的單書頁。 */
	private handleScannedCode(code: string): void {
		const cleaned = code.replace(/[-\s]/g, '');

		if (cleaned === this.lastOpenedCode) return;
		this.lastOpenedCode = cleaned;

		this.openBookPage(cleaned);
	}

	private handleManualSubmit(): void {
		const input = document.getElementById('input-isbn') as HTMLInputElement;
		const cleaned = input?.value.replace(/[-\s]/g, '') ?? '';

		if (!/^\d{13}$/.test(cleaned) && !/^\d{9}[\dX]$/i.test(cleaned)) {
			UIUtils.showToast('請輸入 10 或 13 位數的 ISBN');
			return;
		}

		UIUtils.hideModal('modal-manual');
		this.lastOpenedCode = cleaned;
		this.openBookPage(cleaned);
	}

	/**
	 * 在新分頁開啟單書頁，掃描器留在原地。
	 *
	 * 條碼解碼的 callback 不算使用者手勢，瀏覽器（iOS Safari 尤其）會擋掉
	 * window.open。擋掉時退回顯示一張帶連結的卡片——點它就是手勢，一定開得起來。
	 * 注意不能用 window.open(url, '_blank', 'noopener')：帶 noopener 時瀏覽器
	 * 一律回傳 null，就無法分辨「被擋」還是「開成功」了。改成開完手動切斷 opener。
	 */
	private openBookPage(code: string): void {
		const url = `${BOOK_PAGE_BASE}${code}/`;
		this.showResult(code, url);

		const opened = window.open(url, '_blank');

		if (opened) {
			opened.opener = null;
			UIUtils.showToast(`已開啟 ${code}`, 2000);
		} else {
			UIUtils.showToast('瀏覽器擋下了新分頁，請點下方連結', 4000);
		}
	}

	/** 顯示最後掃到的一本，讓被擋下時（或想再看一次時）有地方可以點。 */
	private showResult(code: string, url: string): void {
		const result = document.getElementById('scan-result');
		const link = document.getElementById('scan-result-link') as HTMLAnchorElement | null;
		const codeEl = document.getElementById('scan-result-code');

		if (!result || !link || !codeEl) return;

		codeEl.textContent = code;
		link.href = url;
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
