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

const NEON_CONNECTION_STRING = 'postgresql://neondb_owner:npg_UzbycfQ4M7tg@ep-bitter-meadow-app9f5r3.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require'; // Neon panelidan olingan ulanish kodigit init


// --- SOZLAMALAR ---
const token = '8905749647:AAEnnXevqVShjmXGJwxkSnkASYK0_jA_QM0'; // BotFather'dan olingan token
const SUPER_ADMIN_ID = 5022826584;        // O'zingizning Telegram ID raqamingiz
const TARGET_CHAT_ID = -1003995579963;  // Test yuboriladigan doimiy guruh yoki kanal ID-si

const pool = new Pool({
    connectionString: NEON_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(token, { polling: true });
let activeQuizzes = []; 
let adminState = {}; 
let currentExcelName = ""; // Yuklangan Excel faylining nomi
let pollCorrectAnswers = {}; // Testlarni tekshirish uchun xotira

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

// Menu tugmalari (Yangi tugma qo'shildi)
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
            const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames], { header: 1 });
            activeQuizzes = []; 

            for (let row of data) {
                if (!row || row.length === 0) continue; 
                let cleanRow = row.map(cell => cell !== undefined && cell !== null ? String(cell).trim() : "");
                if (cleanRow[0] === "") continue; 
                
                let question = cleanRow[0]; 
                let rawOptions = cleanRow.slice(1); 
                let cleanOptions = rawOptions.filter(opt => opt !== "");
                
                if (cleanOptions.length < 2) continue; 

                let correctAnswerIndex = cleanOptions.findIndex(opt => opt.startsWith('*') || opt.endsWith('*'));
                if (correctAnswerIndex !== -1) {
                    let finalOptions = cleanOptions.map(opt => opt.replace(/\*/g, '').trim());
                    activeQuizzes.push({ question, options: finalOptions, correct_option_id: correctAnswerIndex });
                }
            }

            if (fs.existsSync(correctedFilePath)) fs.unlinkSync(correctedFilePath);

            if (activeQuizzes.length === 0) {
                bot.sendMessage(chatId, "⚠️ Mos keladigan savollar topilmadi! Yulduzcha (*) qo'yilganini tekshiring.", adminKeyboard);
            } else {
                bot.sendMessage(chatId, "✅ Excel muvaffaqiyatli yuklandi!\n🎯 Jami topilgan savollar: " + activeQuizzes.length + " ta.", adminKeyboard);
            }
        } catch (error) {
            bot.sendMessage(chatId, "❌ Excel faylni o'qishda xatolik.");
            console.error(error);
        }
    }
});

// Bot tugmalari boshqaruvi
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!(await isAdmin(chatId))) return;

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

            bot.sendMessage(chatId, "🚀 Test sozlangan guruhga yuborilmoqda...", adminKeyboard);
            
            try {
                // YANGI REVOLUTION: Yangi test boshlanishidan oldin vaqtinchalik joriy natijalar jadvalini tozalaymiz
                await pool.query('TRUNCATE TABLE current_results');
                pollCorrectAnswers = {}; 

                const startMessage = "🔔 \"" + currentExcelName + "\" nomli yangi test boshlanmoqda!\n\n🎯 Jami savollar soni: " + activeQuizzes.length + " ta\n⏱ Har bir savol uchun vaqt: " + seconds + " soniya.\n\nMuvaffaqiyatlar tilaymiz!";
                await bot.sendMessage(TARGET_CHAT_ID, startMessage);
                
                const waitBetweenPolls = (seconds * 1000) + 2000; 

                for (let i = 0; i < activeQuizzes.length; i++) {
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

                    if (i < activeQuizzes.length - 1) {
                        await new Promise(r => setTimeout(r, waitBetweenPolls));
                    }
                }
                
                bot.sendMessage(chatId, "✅ Barcha testlar guruhga yuborildi! Test tugagach, guruhga natijalarni ulashish uchun '📢 Guruhga natijalarni yuborish' tugmasini bosing.", adminKeyboard);
            } catch (err) {
                bot.sendMessage(chatId, "❌ Xato yuz berdi: " + err.message, adminKeyboard);
            }
            return;
        }
    }

    // ADMIN TAZLIL PANEL (Umumiy va Joriy test natijalari birga ko'rinadi)
    if (text === "📊 Natijalarni tahlil qilish") {
        try {
            // 1. Joriy test natijalari
            const currentRes = await pool.query('SELECT * FROM current_results ORDER BY correct_count DESC');
            // 2. Umumiy (Tarixiy) natijalar
            const totalRes = await pool.query('SELECT * FROM results ORDER BY correct_count DESC');
            
            let report = "📈 **ADMIN UCHUN TEST TAHLILI**\n\n";
            
            report += "📝 **Joriy test natijalari (" + (currentExcelName || "Noma'lum") + "):**\n";
            if (currentRes.rows.length === 0) {
                report += "↳ Hozircha joriy testda hech kim qatnashmadi.\n";
            } else {
                currentRes.rows.forEach((user, i) => {
                    report += (i + 1) + ". 👤 " + user.name + " — Ball: " + (user.correct_count * 10) + " (" + user.correct_count + " ta)\n";
                });
            }

            report += "\n🏆 **Tizimdagi umumiy (barcha davrlar) reytingi:**\n";
            if (totalRes.rows.length === 0) {
                report += "↳ Bazada umumiy natijalar mavjud emas.\n";
            } else {
                totalRes.rows.forEach((user, i) => {
                    report += (i + 1) + ". 👤 " + user.name + " — Umumiy ball: " + (user.correct_count * 10) + "\n";
                });
            }

            bot.sendMessage(chatId, report);
        } catch (err) {

bot.sendMessage(chatId, "❌ Natijalarni yuklashda xatolik.");
}
}
// GURUH VA KANALGA FAQAT JORIY TEST NATIJASINI YUBORISH (YANGI FUNKSIYA)
else if (text === "📢 Guruhga natijalarni yuborish") {
try {
const currentRes = await pool.query('SELECT * FROM current_results ORDER BY correct_count DESC');
if (currentRes.rows.length === 0) {
return bot.sendMessage(chatId, "⚠️ Guruhga yuborish uchun joriy testda natijalar topilmadi.");
}
let groupReport = "🏁 " + currentExcelName + " test natijalari e'lon qilindi!\n\n";
groupReport += "📊 Ishtirokchilar va to'plangan ballar:\n\n";
currentRes.rows.forEach((user, i) => {
let medal = i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : "• ";
groupReport += medal + user.name + " — 🏆 " + (user.correct_count * 10) + " ball\n";
});
groupReport += "\nBarcha ishtirokchilarga rahmat! 👏";
// Guruhga faqat joriy test natijasini jo'natamiz
await bot.sendMessage(TARGET_CHAT_ID, groupReport);
bot.sendMessage(chatId, "✅ Joriy test natijalari guruh/kanalga muvaffaqiyatli yuborildi!", adminKeyboard);
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
bot.sendMessage(chatId, "🗑 Barcha umumiy va joriy natijalar bazadan butunlay tozalandi.");
}
else if (text === "📢 Testni guruh/kanalga yuborish") {
if (activeQuizzes.length === 0) return bot.sendMessage(chatId, "⚠️ Avval Excel yuklang!");
bot.sendMessage(chatId, "⏱ Har bir savol necha soniya tursin? (Faqat raqam yuboring):", { reply_markup: { remove_keyboard: true } });
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
// Javoblar hisoblagichi (YANGILANDI: Ham umumiy, ham joriy bazaga alohida yozadi)
bot.on('poll_answer', async (answer) => {
const userId = answer.user.id;
const pollId = answer.poll_id;
const userChosenOption = answer.option_ids[0];
const realCorrectOptionId = pollCorrectAnswers[pollId];
// To'g'ri javob tekshiruvi
if (realCorrectOptionId === undefined || userChosenOption !== realCorrectOptionId) {
return;
}
const fullName = (answer.user.first_name || "") + (answer.user.username ? " (@" + answer.user.username + ")" : "");
try {
// 1. Umumiy (tarixiy) bazaga qo'shish
await pool.query("INSERT INTO results (id, name, correct_count) VALUES ($1, $2, 1) ON CONFLICT (id) DO UPDATE SET name = $2, correct_count = results.correct_count + 1", [userId, fullName]);
// 2. Vaqtinchalik joriy test bazasiga qo'shish
await pool.query("INSERT INTO current_results (id, name, correct_count) VALUES ($1, $2, 1) ON CONFLICT (id) DO UPDATE SET name = $2, correct_count = current_results.correct_count + 1", [userId, fullName]);
} catch (err) {
console.error("Ballarni yozishda xato:", err);
}
});