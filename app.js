/**
 * 健康记录 PWA - 纯本地存储版本
 * 数据存储在浏览器 IndexedDB，无需服务器
 */

// ============================================================
// IndexedDB 数据库操作
// ============================================================

const DB_NAME = 'HealthRecordsDB';
const DB_VERSION = 1;
let db = null;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            // 血糖表
            if (!database.objectStoreNames.contains('glucose')) {
                const glucoseStore = database.createObjectStore('glucose', {
                    keyPath: 'id',
                    autoIncrement: true
                });
                glucoseStore.createIndex('recordedAt', 'recordedAt', { unique: false });
            }

            // 血压表
            if (!database.objectStoreNames.contains('pressure')) {
                const pressureStore = database.createObjectStore('pressure', {
                    keyPath: 'id',
                    autoIncrement: true
                });
                pressureStore.createIndex('recordedAt', 'recordedAt', { unique: false });
            }
        };
    });
}

// 保存血糖
function saveGlucose(value, notes = '') {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('glucose', 'readwrite');
        const store = tx.objectStore('glucose');
        const record = {
            value: value,
            unit: 'mmol/L',
            recordedAt: new Date().toISOString(),
            notes: notes
        };
        const request = store.add(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 保存血压
function savePressure(systolic, diastolic, notes = '') {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pressure', 'readwrite');
        const store = tx.objectStore('pressure');
        const record = {
            systolic: systolic,
            diastolic: diastolic,
            recordedAt: new Date().toISOString(),
            notes: notes
        };
        const request = store.add(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 获取最近记录
function getRecent(storeName, limit = 10) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index('recordedAt');
        const request = index.openCursor(null, 'prev');
        const results = [];

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor && results.length < limit) {
                results.push(cursor.value);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

// 获取指定天数内的统计
function getStats(days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffISO = cutoff.toISOString();

    return Promise.all([
        getFilteredRecords('glucose', cutoffISO),
        getFilteredRecords('pressure', cutoffISO)
    ]).then(([glucoseRecords, pressureRecords]) => {
        // 血糖统计
        const glucoseStats = {
            count: glucoseRecords.length,
            average: null,
            min: null,
            max: null
        };
        if (glucoseRecords.length > 0) {
            const values = glucoseRecords.map(r => r.value);
            glucoseStats.average = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
            glucoseStats.min = Math.min(...values);
            glucoseStats.max = Math.max(...values);
        }

        // 血压统计
        const pressureStats = {
            count: pressureRecords.length,
            avgSystolic: null,
            avgDiastolic: null,
            minSystolic: null,
            maxSystolic: null,
            minDiastolic: null,
            maxDiastolic: null
        };
        if (pressureRecords.length > 0) {
            const systolics = pressureRecords.map(r => r.systolic);
            const diastolics = pressureRecords.map(r => r.diastolic);
            pressureStats.avgSystolic = Math.round(systolics.reduce((a, b) => a + b, 0) / systolics.length);
            pressureStats.avgDiastolic = Math.round(diastolics.reduce((a, b) => a + b, 0) / diastolics.length);
            pressureStats.minSystolic = Math.min(...systolics);
            pressureStats.maxSystolic = Math.max(...systolics);
            pressureStats.minDiastolic = Math.min(...diastolics);
            pressureStats.maxDiastolic = Math.max(...diastolics);
        }

        return { glucose: glucoseStats, pressure: pressureStats };
    });
}

function getFilteredRecords(storeName, cutoffISO) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index('recordedAt');
        const range = IDBKeyRange.lowerBound(cutoffISO);
        const request = index.openCursor(range);
        const results = [];

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                results.push(cursor.value);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

// ============================================================
// 语音识别
// ============================================================

let recognition = null;
let isListening = false;

function initSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        document.getElementById('statusBar').textContent = '您的浏览器不支持语音识别';
        document.getElementById('micBtn').style.opacity = '0.5';
        return false;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
        isListening = true;
        document.getElementById('micBtn').classList.add('listening');
        document.getElementById('statusBar').textContent = '正在聆听...';
    };

    recognition.onresult = (event) => {
        const transcript = event.results[event.results.length - 1][0].transcript;
        document.getElementById('result').textContent = transcript;

        if (event.results[event.results.length - 1].isFinal) {
            processVoiceInput(transcript);
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech error:', event.error);
        let errorMsg = '识别出错';
        if (event.error === 'not-allowed') {
            errorMsg = '请允许麦克风权限';
        } else if (event.error === 'no-speech') {
            errorMsg = '没有检测到语音';
        }
        document.getElementById('statusBar').textContent = errorMsg;
        stopListening();
    };

    recognition.onend = () => {
        stopListening();
    };

    return true;
}

function toggleListening() {
    // 用户点击时启用语音播报
    enableSpeech();

    if (isListening) {
        recognition.stop();
    } else {
        if (!recognition && !initSpeechRecognition()) {
            return;
        }
        try {
            recognition.start();
        } catch (e) {
            console.error('Start error:', e);
        }
    }
}

function stopListening() {
    isListening = false;
    document.getElementById('micBtn').classList.remove('listening');
    document.getElementById('statusBar').textContent = '点击麦克风开始语音记录';
}

// ============================================================
// 语音解析和处理
// ============================================================

function parseHealthText(text) {
    const result = {};

    // 血糖：支持 "血糖6.4", "血糖 6.4", "血糖：6.4"
    const sugarMatch = text.match(/血糖[：:\s]*([0-9]+(?:\.[0-9]+)?)/);
    if (sugarMatch) {
        result.bloodSugar = parseFloat(sugarMatch[1]);
    }

    // 血压：支持 "血压130 80", "血压 130/80", "血压：130 80"
    const bpMatch = text.match(/血压[：:\s]*([0-9]{2,3})[^\d]{1,3}([0-9]{2,3})/);
    if (bpMatch) {
        const sys = parseInt(bpMatch[1]);
        const dia = parseInt(bpMatch[2]);
        if (sys >= 60 && sys <= 250 && dia >= 40 && dia <= 150) {
            result.systolic = sys;
            result.diastolic = dia;
        }
    }

    return result;
}

async function processVoiceInput(text) {
    const parsed = parseHealthText(text);

    if (Object.keys(parsed).length === 0) {
        const speech = '没有听清楚，请说例如：血糖6.4，或者血压130 85';
        document.getElementById('result').textContent = speech;
        document.getElementById('statusBar').textContent = '请重试';
        speak(speech);
        return;
    }

    const savedParts = [];

    try {
        if (parsed.bloodSugar) {
            await saveGlucose(parsed.bloodSugar, text);
            savedParts.push(`血糖${parsed.bloodSugar}`);
        }

        if (parsed.systolic && parsed.diastolic) {
            await savePressure(parsed.systolic, parsed.diastolic, text);
            savedParts.push(`血压${parsed.systolic}，${parsed.diastolic}`);
        }

        const speech = '好的，已记录' + savedParts.join('，') + '。';
        document.getElementById('result').textContent = speech;
        document.getElementById('statusBar').textContent = '记录成功';
        speak(speech);

        // 刷新历史列表
        loadHistory(currentTab);

    } catch (error) {
        console.error('Save error:', error);
        document.getElementById('statusBar').textContent = '保存失败';
    }
}

// ============================================================
// 语音播报 (iOS Safari 兼容版)
// ============================================================

let voices = [];
let isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// 初始化语音
function initSpeech() {
    if (!('speechSynthesis' in window)) {
        console.log('浏览器不支持语音合成');
        return;
    }

    // 获取可用语音
    const loadVoices = () => {
        voices = speechSynthesis.getVoices();
        console.log('可用语音:', voices.length, voices.map(v => v.lang));
    };

    // iOS 需要延迟加载
    if (isIOS) {
        setTimeout(loadVoices, 100);
    } else {
        loadVoices();
    }
    speechSynthesis.onvoiceschanged = loadVoices;
}

// 启用语音（iOS Safari 必须在用户交互中直接调用）
function enableSpeech() {
    // iOS Safari 需要在点击事件中直接触发一次
    if (isIOS && 'speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(' ');
        utterance.volume = 0.01;
        utterance.rate = 10;
        speechSynthesis.speak(utterance);
    }
}

function speak(text) {
    console.log('准备播报:', text);

    if (!('speechSynthesis' in window)) {
        console.log('浏览器不支持语音合成');
        alert(text);
        return;
    }

    // iOS Safari 特殊处理
    if (isIOS) {
        speakIOS(text);
    } else {
        speakDefault(text);
    }
}

// iOS Safari 专用播报
function speakIOS(text) {
    // iOS 必须先取消，等一下再播
    speechSynthesis.cancel();

    setTimeout(() => {
        const utterance = new SpeechSynthesisUtterance(text);

        // iOS 中文语音设置
        utterance.lang = 'zh-CN';
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        // 尝试使用中文语音
        if (voices.length > 0) {
            const zhVoice = voices.find(v =>
                v.lang === 'zh-CN' ||
                v.lang === 'zh-TW' ||
                v.lang.startsWith('zh')
            );
            if (zhVoice) {
                utterance.voice = zhVoice;
                console.log('使用语音:', zhVoice.name);
            }
        }

        utterance.onstart = () => {
            console.log('iOS 开始播报');
            document.getElementById('statusBar').textContent = '正在播报...';
        };

        utterance.onend = () => {
            console.log('iOS 播报结束');
            document.getElementById('statusBar').textContent = '播报完成';
        };

        utterance.onerror = (e) => {
            console.error('iOS 播报错误:', e.error);
            document.getElementById('statusBar').textContent = '播报失败: ' + e.error;
        };

        speechSynthesis.speak(utterance);
    }, 250);
}

// 默认播报（Android/桌面）
function speakDefault(text) {
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    const zhVoice = voices.find(v => v.lang.includes('zh') || v.lang.includes('CN'));
    if (zhVoice) {
        utterance.voice = zhVoice;
    }

    utterance.onstart = () => console.log('开始播报');
    utterance.onend = () => console.log('播报结束');
    utterance.onerror = (e) => console.error('播报错误:', e);

    setTimeout(() => {
        speechSynthesis.speak(utterance);
    }, 100);
}

// ============================================================
// 汇总报告
// ============================================================

async function showSummary(type) {
    // iOS: 必须在点击事件中先触发一次语音
    enableSpeech();

    let speech = '';
    let days = 7;

    if (type === 'today') {
        days = 1;
    } else if (type === '3day') {
        days = 3;
    } else if (type === 'weekly') {
        days = 7;
    } else if (type === 'latest') {
        // 最新数据
        const [latestGlucose, latestPressure] = await Promise.all([
            getRecent('glucose', 1),
            getRecent('pressure', 1)
        ]);

        const parts = [];
        if (latestGlucose.length > 0) {
            const g = latestGlucose[0];
            parts.push(`最近血糖${g.value}，${formatTime(g.recordedAt)}`);
        } else {
            parts.push('暂无血糖记录');
        }

        if (latestPressure.length > 0) {
            const p = latestPressure[0];
            parts.push(`最近血压，高压${p.systolic}，低压${p.diastolic}，${formatTime(p.recordedAt)}`);
        } else {
            parts.push('暂无血压记录');
        }

        speech = parts.join('。') + '。';
        document.getElementById('result').textContent = speech;
        speak(speech);
        return;
    }

    const stats = await getStats(days);
    const periodName = type === 'today' ? '今天' : (type === '3day' ? '过去3天' : '过去7天');

    const parts = [`${periodName}健康数据汇报。`];

    // 血糖
    if (stats.glucose.count === 0) {
        parts.push('没有血糖记录。');
    } else {
        parts.push(`血糖共${stats.glucose.count}次，平均${stats.glucose.average}，`);
        parts.push(`最低${stats.glucose.min}，最高${stats.glucose.max}。`);
    }

    // 血压
    if (stats.pressure.count === 0) {
        parts.push('没有血压记录。');
    } else {
        parts.push(`血压共${stats.pressure.count}次，平均高压${stats.pressure.avgSystolic}，低压${stats.pressure.avgDiastolic}，`);
        parts.push(`收缩压${stats.pressure.minSystolic}到${stats.pressure.maxSystolic}，`);
        parts.push(`舒张压${stats.pressure.minDiastolic}到${stats.pressure.maxDiastolic}。`);
    }

    parts.push('以上数据仅供参考。');

    speech = parts.join('');
    document.getElementById('result').textContent = speech;
    speak(speech);
}

// ============================================================
// 历史记录
// ============================================================

let currentTab = 'glucose';

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    loadHistory(tab);
}

async function loadHistory(type = 'glucose') {
    const records = await getRecent(type, 20);
    const listEl = document.getElementById('historyList');

    if (records.length === 0) {
        listEl.innerHTML = '<div class="empty-state">暂无记录</div>';
        return;
    }

    listEl.innerHTML = records.map(r => {
        if (type === 'glucose') {
            return `
                <div class="history-item">
                    <span class="value">血糖 ${r.value} mmol/L</span>
                    <span class="time">${formatTime(r.recordedAt)}</span>
                </div>
            `;
        } else {
            return `
                <div class="history-item">
                    <span class="value">血压 ${r.systolic}/${r.diastolic}</span>
                    <span class="time">${formatTime(r.recordedAt)}</span>
                </div>
            `;
        }
    }).join('');
}

function formatTime(isoTime) {
    const date = new Date(isoTime);
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days === 1) return '昨天';
    if (days < 7) return `${days}天前`;
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

// ============================================================
// 数据导出
// ============================================================

async function exportData() {
    const [glucoseRecords, pressureRecords] = await Promise.all([
        getRecent('glucose', 1000),
        getRecent('pressure', 1000)
    ]);

    const data = {
        exportTime: new Date().toISOString(),
        glucose: glucoseRecords,
        pressure: pressureRecords
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `health_data_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    document.getElementById('statusBar').textContent = '数据已导出';
}

// ============================================================
// 初始化
// ============================================================

async function init() {
    try {
        await initDB();
        initSpeechRecognition();
        initSpeech();
        loadHistory('glucose');

        // 检查 URL 参数自动执行
        const params = new URLSearchParams(window.location.search);
        const action = params.get('action');

        if (action === 'record') {
            // 显示大按钮覆盖层，等待用户点击
            showAutoRecordOverlay();
        } else if (action === 'weekly') {
            showAutoAction('weekly');
        } else if (action === '3day') {
            showAutoAction('3day');
        } else if (action === 'latest') {
            showAutoAction('latest');
        }

    } catch (error) {
        console.error('Init error:', error);
        document.getElementById('statusBar').textContent = '初始化失败';
    }
}

// 注册 Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('SW registered'))
        .catch(err => console.log('SW registration failed:', err));
}

// 自动录音覆盖层
function showAutoRecordOverlay() {
    const overlay = document.getElementById('autoRecordOverlay');
    overlay.style.display = 'flex';
}

function startAutoRecord() {
    const overlay = document.getElementById('autoRecordOverlay');
    const content = overlay.querySelector('.auto-record-content');

    // 启用语音
    enableSpeech();

    // 初始化语音识别
    if (!recognition && !initSpeechRecognition()) {
        overlay.style.display = 'none';
        return;
    }

    // 更新界面显示正在聆听
    content.innerHTML = `
        <div class="big-mic" style="color: #ff5722;">🎤</div>
        <p>正在聆听...</p>
        <p class="hint">请说：血糖 6.4 或 血压 130 85</p>
    `;
    overlay.classList.add('listening');

    // 设置识别结果处理
    recognition.onresult = (event) => {
        const transcript = event.results[event.results.length - 1][0].transcript;

        // 显示识别到的文字
        content.innerHTML = `
            <div class="big-mic">✓</div>
            <p>识别到：${transcript}</p>
            <p class="hint">正在处理...</p>
        `;

        if (event.results[event.results.length - 1].isFinal) {
            // 处理语音输入并播报
            processAutoVoiceInput(transcript, overlay);
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech error:', event.error);
        content.innerHTML = `
            <div class="big-mic">❌</div>
            <p>识别失败</p>
            <p class="hint">轻触重试</p>
        `;
        overlay.classList.remove('listening');
        overlay.onclick = startAutoRecord;
    };

    recognition.onend = () => {
        overlay.classList.remove('listening');
    };

    // 开始录音
    try {
        recognition.start();
    } catch (e) {
        console.error('Start error:', e);
        overlay.style.display = 'none';
    }
}

// 处理自动模式的语音输入
async function processAutoVoiceInput(text, overlay) {
    const content = overlay.querySelector('.auto-record-content');
    const parsed = parseHealthText(text);

    if (Object.keys(parsed).length === 0) {
        content.innerHTML = `
            <div class="big-mic">❓</div>
            <p>没有听清楚</p>
            <p class="hint">轻触屏幕重试</p>
        `;
        speak('没有听清楚，请重试');
        overlay.onclick = startAutoRecord;
        return;
    }

    const savedParts = [];

    try {
        if (parsed.bloodSugar) {
            await saveGlucose(parsed.bloodSugar, text);
            savedParts.push(`血糖${parsed.bloodSugar}`);
        }

        if (parsed.systolic && parsed.diastolic) {
            await savePressure(parsed.systolic, parsed.diastolic, text);
            savedParts.push(`血压${parsed.systolic}，${parsed.diastolic}`);
        }

        const speechText = '好的，已记录' + savedParts.join('，') + '。';

        // 显示成功
        content.innerHTML = `
            <div class="big-mic">✅</div>
            <p>记录成功</p>
            <p class="hint">${savedParts.join('，')}</p>
        `;

        // 语音播报
        speak(speechText);

        // 刷新历史列表
        loadHistory(currentTab);

        // 3秒后关闭覆盖层
        setTimeout(() => {
            overlay.style.display = 'none';
            // 恢复原始内容
            content.innerHTML = `
                <div class="big-mic">🎤</div>
                <p>轻触屏幕开始说话</p>
                <p class="hint">例如：血糖 6.4 / 血压 130 85</p>
            `;
            overlay.onclick = startAutoRecord;
        }, 3000);

    } catch (error) {
        console.error('Save error:', error);
        content.innerHTML = `
            <div class="big-mic">❌</div>
            <p>保存失败</p>
            <p class="hint">轻触重试</p>
        `;
        overlay.onclick = startAutoRecord;
    }
}

// 自动执行操作（显示提示后执行）
function showAutoAction(type) {
    const overlay = document.getElementById('autoRecordOverlay');
    const content = overlay.querySelector('.auto-record-content');

    content.innerHTML = `
        <div class="big-mic">📊</div>
        <p>轻触屏幕播报${type === 'weekly' ? '周报' : type === '3day' ? '三日报' : '最新数据'}</p>
    `;

    overlay.style.display = 'flex';
    overlay.onclick = () => {
        enableSpeech();
        overlay.style.display = 'none';
        showSummary(type);
    };
}

// 启动
window.addEventListener('load', init);
