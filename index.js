const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot muvaffaqiyatli ishlamoqda!');
});

app.listen(PORT, () => {
    console.log(`Soxta veb-server ${PORT}-portda ishga tushdi.`);
});


const TelegramBot = require('node-telegram-bot-api');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const NEON_CONNECTION_STRING = 'postgresql://neondb_owner:npg_UzbycfQ4M7tg@ep-bitter-meadow-app9f5r3.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require'; 

const token = '8905749647:AAEnnXevqVShjmXGJwxkSnkASYK0_jA_QM0'; 
const SUPER_ADMIN_ID = 5022826584;        
const TARGET_CHAT_ID = -1003995579963;  

const pool = new Pool({
    connectionString: NEON_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(token, { polling: true });
let activeQuizzes = []; 
let adminState = {}; 
let currentExcelName = ""; // Yuklangan Excel faylining nomi
let pollCorrectAnswers = {}; // Testlarni tekshirish uchun xotira

// Testni nazorat qilish o'zgaruvchilari
let isQuizRunning = false;
let quizTimeoutId = null;

// Adminlikni tekshirish
async function isAdmin(chatId) {
    if (chatId === SUPER_ADMIN_ID) return true;
    try {
        const res = await pool.query('SELECT * FROM admins WHERE telegram_id = \$1', [chatId]);
        return res.rows.length > 0;
    } catch (err) {
        return false;
    }
}

// Menu klaviaturalari
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "📊 Natijalarni tahlil qilish" }, { text: "📢 Guruhga natijalarni yuborish" }],
            [{ text: "📢 Testni guruh/kanalga yuborish" }, { text: "🧹 Ma'lumotlarni tozalash" }],
            [{ text: "➕ Admin Qo'shish" }, { text: "➖ Admin O'chirish" }, { text: "👥 Adminlar Ro'yxati" }]
        ],
        resize_keyboard: true
    }
};

const stopKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🛑 Testni to'xtatish (Stop)" }]
        ],
        resize_keyboard: true
    }
};

console.log("🚀 Bot Neon.tech bulutli bazasi bilan muvaffaqiyatli ishga tushdi...");

// /start buyrug'i
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (await isAdmin(chatId)) {
        bot.sendMessage(chatId, "👋 Salom Admin! Panelga xush kelibsiz.\nTest yuklash uchun menga Excel (.xlsx) fayl yuboring.", adminKeyboard);
    } else {
        bot.sendMessage(chatId, "👋 Salom! Bu test tizimi boti. Admin guruh yoki kanalga test yuborganida ishtirok etishingiz mumkin.");
    }
});

// Excel faylni qabul qilish
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    if (!(await isAdmin(chatId))) return;

    if (msg.document.file_name.endsWith('.xlsx')) {
        bot.sendMessage(chatId, "⏳ Excel fayl yuklab olinmoqda va tahlil qilinmoqda...");
        try {
            currentExcelName = msg.document.file_name.replace('.xlsx', ''); 
            
            const downloadDir = __dirname;
            const rawFilePath = await bot.downloadFile(msg.document.file_id, downloadDir);
            const correctedFilePath = path.join(downloadDir, "temp_" + Date.now() + ".xlsx");
            fs.renameSync(rawFilePath, correctedFilePath);
            
            const workbook = xlsx.readFile(correctedFilePath);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1 });
            activeQuizzes = []; 

            for (let row of rawData) {
                if (!row || row.length < 2) continue; 
                
                let cleanRow = row.map(cell => cell !== undefined && cell !== null ? String(cell).trim() : "");
                let question = cleanRow[0]; 
                if (!question || question === "") continue;
                
                let rawOptions = cleanRow.slice(1); 
                let cleanOptions = rawOptions.filter(opt => opt !== "");
                if (cleanOptions.length < 2) continue; 

                let correctAnswerIndex = cleanOptions.findIndex(opt => opt.startsWith('*') || opt.endsWith('*'));
                if (correctAnswerIndex !== -1) {
                    let finalOptions = cleanOptions.map(opt => opt.replace(/\*/g, '').trim());
                    activeQuizzes.push({ question: question, options: finalOptions, correct_option_id: correctAnswerIndex });
                }
            }

            if (fs.existsSync(correctedFilePath)) fs.unlinkSync(correctedFilePath);

            if (activeQuizzes.length === 0) {
                bot.sendMessage(chatId, "⚠️ Mos keladigan savollar topilmadi! Yulduzcha (*) qo'yilganini tekshiring.", adminKeyboard);
            } else {
                bot.sendMessage(chatId, "✅ Excel muvaffaqiyatli yuklandi!\n🎯 Jami topilgan haqiqiy savollar: " + activeQuizzes.length + " ta.", adminKeyboard);
            }
        } catch (error) {
            bot.sendMessage(chatId, "❌ Excel faylni o'qishda xatolik yuz berdi.");
            console.error(error);
        }
    }
});

// Joriy test natijalarini guruhga avtomatik yuborish funksiyasi
async function sendCurrentResultsToGroup() {
    try {
        const currentRes = await pool.query('SELECT * FROM current_results ORDER BY correct_count DESC');
        let groupReport = "🏁 **\"" + currentExcelName + "\" test natijalari (Joriy):**\n\n";
        
        if (currentRes.rows.length === 0) {
            groupReport += "Afsuski, ushbu testda hech kim to'g'ri javob bera olmadi. 🤷‍♂️";
        } else {
            currentRes.rows.forEach((user, i) => {
                let medal = i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : "• ";
                groupReport += medal + user.name + " — " + (user.correct_count * 10) + " ball\n";
            });
        }
        await bot.sendMessage(TARGET_CHAT_ID, groupReport);
    } catch (err) {
        console.error("Guruhga joriy natijani yuborishda xato:", err);
    }
}

// Bot tugmalari boshqaruvi
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!(await isAdmin(chatId))) return;

    if (text === "🛑 Testni to'xtatish (Stop)") {
        if (!isQuizRunning) {
            return bot.sendMessage(chatId, "⚠️ Hozirda hech qanday test faol emas.", adminKeyboard);
        }
        
        isQuizRunning = false;
        if (quizTimeoutId) clearTimeout(quizTimeoutId); 
        
        await bot.sendMessage(TARGET_CHAT_ID, "🛑 Test admin tomonidan muddatidan oldin to'xtatildi!");
        bot.sendMessage(chatId, "🛑 Test muvaffaqiyatli to'xtatildi! Natijalar guruhga yuborilmoqda...", adminKeyboard);
        
        await sendCurrentResultsToGroup(); 
        return;
    }

    if (adminState[chatId]) {
        const state = adminState[chatId];
        delete adminState[chatId]; 

        if (state === 'WAITING_FOR_ADD_ADMIN') {
            const newAdminId = parseInt(text);
            if (!isNaN(newAdminId)) {
                await pool.query('INSERT INTO admins (telegram_id) VALUES (\$1) ON CONFLICT DO NOTHING', [newAdminId]);
                bot.sendMessage(chatId, "✅ Yangi admin qo'shildi! ID: " + newAdminId, adminKeyboard);
            }
            return;
        }
        if (state === 'WAITING_FOR_REMOVE_ADMIN') {
            const removeId = parseInt(text);
            if (removeId !== SUPER_ADMIN_ID) {
                await pool.query('DELETE FROM admins WHERE telegram_id = \$1', [removeId]);
                bot.sendMessage(chatId, "🗑 Admin o'chirish yakunlandi.", adminKeyboard);
            }
            return;
        }
        
        // --- VAQT CHEKLOVINI QABUL QILISH VA TESTNI BOSHLASH ---
        if (state === 'WAITING_FOR_QUIZ_TIME') {
            let seconds = parseInt(text.replace('s', '').trim());
            
            if (isNaN(seconds) || seconds < 10 || seconds > 600) {
                return bot.sendMessage(chatId, "⚠️ Taymer kamida 10 va ko'pi bilan 600 soniya bo'lishi shart.\n\nQaytadan kiriting:", { reply_markup: { remove_keyboard: true } });
            }

            bot.sendMessage(chatId, "🚀 Test boshlandi! Uni to'xtatish uchun pastdagi tugmani bosing:", stopKeyboard);
            
            try {
                await pool.query('TRUNCATE TABLE current_results');
                pollCorrectAnswers = {}; 
                isQuizRunning = true;

                const startMessage = "🔔 \"" + currentExcelName + "\" nomli yeni test boshlanmoqda!\n\n🎯 Jami savollar soni: " + activeQuizzes.length + " ta\n⏱ Har bir savol uchun vaqt: " + seconds + " soniya.\n\nMuvaffaqiyatlar tilaymiz!";
                await bot.sendMessage(TARGET_CHAT_ID, startMessage);
                
                const waitBetweenPolls = (seconds * 1000) + 2000; 

                for (let i = 0; i < activeQuizzes.length; i++) {
                    if (!isQuizRunning) break; 

                    const quiz = activeQuizzes[i];
                    const sentPollMessage = await bot.sendPoll(TARGET_CHAT_ID, "[" + (i + 1) + "/" + activeQuizzes.length + "] " + quiz.question, quiz.options, {
                        type: 'quiz',
                        correct_option_id: quiz.correct_option_id,
                        is_anonymous: false,
                        open_period: seconds 
                    });

                    if (sentPollMessage && sentPollMessage.poll) {
                        pollCorrectAnswers[sentPollMessage.poll.id] = quiz.correct_option_id;
                    }

                    // TUZATILISHI: Oxirgi savol yuborilgandan keyin ham uning vaqti tugashini kutish shart!
                    if (isQuizRunning) {
                        await new Promise(resolve => {
quizTimeoutId = setTimeout(resolve, waitBetweenPolls);
});
}
}
if (isQuizRunning) {
isQuizRunning = false;
bot.sendMessage(chatId, "✅ Barcha testlar yakunlandi va vaqti tugadi! Natijalar guruhga yuborilmoqda...", adminKeyboard);
await sendCurrentResultsToGroup();
}
} catch (err) {
isQuizRunning = false;
bot.sendMessage(chatId, "❌ Xato yuz berdi: " + err.message, adminKeyboard);
}
return;
}
}
if (text === "📊 Natijalarni tahlil qilish") {
try {
const res = await pool.query('SELECT * FROM results ORDER BY correct_count DESC');
if (res.rows.length === 0) return bot.sendMessage(chatId, "📭 Natijalar yo'q.");
let report = "📋 Jami umumiy natijalar ro'yxati:\n\n";
res.rows.forEach((user, i) => {
report += (i + 1) + ". 👤 " + user.name + " — Jami ball: " + (user.correct_count * 10) + "\n";
});
bot.sendMessage(chatId, report);
} catch (err) {
bot.sendMessage(chatId, "❌ Natijalarni yuklashda xatolik.");
}
}
else if (text === "📢 Guruhga natijalarni yuborish") {
try {
const totalRes = await pool.query('SELECT * FROM results ORDER BY correct_count DESC');
if (totalRes.rows.length === 0) {
return bot.sendMessage(chatId, "⚠️ Guruhga yuborish uchun umumiy natijalar topilmadi.");
}
let groupReport = "🏆 **BOTDAGI UMUMIY REYTING (JAMI BALLAR) **\n\n";
groupReport += "Barcha o'tkazilgan testlar bo'yicha eng yuqori natijalar:\n\n";
totalRes.rows.forEach((user, i) => {
let medal = i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : "• ";
groupReport += medal + user.name + " — " + (user.correct_count * 10) + " jami ball\n";
});
groupReport += "\nFaoliyatingizda muvaffaqiyatlar! 🎯";
await bot.sendMessage(TARGET_CHAT_ID, groupReport);
bot.sendMessage(chatId, "✅ Umumiy jami ballar reytingi guruhga muvaffaqiyatli yuborildi!", adminKeyboard);
} catch (err) {
bot.sendMessage(chatId, "❌ Guruhga natija yuborishda xatolik.");
}
}
else if (text === "🧹 Ma'lumotlarni tozalash") {
await pool.query('TRUNCATE TABLE results');
await pool.query('TRUNCATE TABLE current_results');
activeQuizzes = [];
currentExcelName = "";
pollCorrectAnswers = {};
bot.sendMessage(chatId, "🗑 Barcha umumiy va joriy ma'lumotlar bazadan tozalandi.");
}
else if (text === "📢 Testni guruh/kanalga yuborish") {
if (activeQuizzes.length === 0) return bot.sendMessage(chatId, "⚠️ Avval Excel yuklang!");
bot.sendMessage(chatId, '⏱ Har bir savol necha soniya tursin? (Faqat raqam yuboring):', { reply_markup: { remove_keyboard: true } });
adminState[chatId] = 'WAITING_FOR_QUIZ_TIME';
}
else if (text === "➕ Admin Qo'shish" && chatId === SUPER_ADMIN_ID) {
bot.sendMessage(chatId, "👤 ID kiriting:", { reply_markup: { remove_keyboard: true } });
adminState[chatId] = 'WAITING_FOR_ADD_ADMIN';
}
else if (text === "➖ Admin O'chirish" && chatId === SUPER_ADMIN_ID) {
bot.sendMessage(chatId, "🗑 ID kiriting:", { reply_markup: { remove_keyboard: true } });
adminState[chatId] = 'WAITING_FOR_REMOVE_ADMIN';
}
else if (text === "👥 Adminlar Ro'yxati") {
try {
const res = await pool.query('SELECT * FROM admins');
let txt = "👥 Adminlar ro'yxati:\n\n1. ID: " + SUPER_ADMIN_ID + " (Bosh Admin)\n";
res.rows.forEach((row, i) => {
txt += (i + 2) + ". ID: " + row.telegram_id + " (Admin)\n";
});
bot.sendMessage(chatId, txt);
} catch (err) {
bot.sendMessage(chatId, "❌ Adminlar ro'yxatida xatolik.");
}
}
});
// Javoblar hisoblagichi
bot.on('poll_answer', async (answer) => {
const userId = answer.user.id;
const pollId = answer.poll_id;
const userChosenOptionArray = answer.option_ids;
const realCorrectOptionId = pollCorrectAnswers[pollId];
if (
realCorrectOptionId === undefined ||
!userChosenOptionArray ||
userChosenOptionArray.length === 0 ||
Number(userChosenOptionArray[0]) !== Number(realCorrectOptionId)
) {
return;
}
const fullName = (answer.user.first_name || "") + (answer.user.username ? " (@" + answer.user.username + ")" : "");
try {
await pool.query('INSERT INTO results (id, name, correct_count) VALUES ($1, $2, 1) ON CONFLICT (id) DO UPDATE SET name = $2, correct_count = results.correct_count + 1', [userId, fullName]);
await pool.query('INSERT INTO current_results (id, name, correct_count) VALUES ($1, $2, 1) ON CONFLICT (id) DO UPDATE SET name = $2, correct_count = current_results.correct_count + 1', [userId, fullName]);
} catch (err) {
console.error("Ballarni yozishda xato:", err);
}
});