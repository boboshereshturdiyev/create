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

// Menu tugmalari
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "📊 Natijalarni tahlil qilish" }, { text: "🧹 Ma'lumotlarni tozalash" }],
            [{ text: "📢 Testni guruh/kanalga yuborish" }],
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
            currentExcelName = msg.document.file_name.replace('.xlsx', ''); // Fayl nomini saqlab qolamiz
            
            const downloadDir = __dirname;
            const rawFilePath = await bot.downloadFile(msg.document.file_id, downloadDir);
            const correctedFilePath = path.join(downloadDir, "temp_" + Date.now() + ".xlsx");
            fs.renameSync(rawFilePath, correctedFilePath);
            
            const workbook = xlsx.readFile(correctedFilePath);
            const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames], { header: 1 });
            activeQuizzes = []; 

            for (let row of data) {
                if (!row || row.length < 2) continue; 
                let question = String(row).trim(); 
                let rawOptions = row.slice(1);       
                let cleanOptions = rawOptions.map(opt => opt !== undefined && opt !== null ? String(opt).trim() : "").filter(opt => opt !== "");
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
                bot.sendMessage(chatId, "✅ Excel muvaffaqiyatli yuklandi!\n🎯 Jami savollar: " + activeQuizzes.length + " ta.", adminKeyboard);
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
                return bot.sendMessage(chatId, "⚠️ Noto'g'ri vaqt kiritildi. Telegram qoidasiga ko'ra vaqt kamida 10 soniya va ko'pi bilan 600 soniya bo'lishi shart.\n\nQaytadan urinib ko'ring:", { reply_markup: { remove_keyboard: true } });
            }

            bot.sendMessage(chatId, "🚀 Test sozlangan guruh/kanalga " + seconds + " soniyalik taymer bilan yuborilmoqda...", adminKeyboard);
            
            try {
                // Hech qanday HTML/Markdown xatosi chiqmasligi uchun parse_mode olib tashlandi va oddiy matnga o'tkazildi
                const startMessage = "🔔 \"" + currentExcelName + "\" nomli test boshlanmoqda!\n\n🎯 Jami savollar soni: " + activeQuizzes.length + " ta\n⏱ Har bir savol uchun vaqt: " + seconds + " soniya.\n\nMuvaffaqiyatlar tilaymiz!";
                await bot.sendMessage(TARGET_CHAT_ID, startMessage);
                
                const waitBetweenPolls = (seconds * 1000) + 2000; 

                // Savollarni ketma-ketlikda yuborish loopi
                for (let i = 0; i < activeQuizzes.length; i++) {
                    const quiz = activeQuizzes[i];
                    
                    await bot.sendPoll(TARGET_CHAT_ID, "[" + (i + 1) + "/" + activeQuizzes.length + "] " + quiz.question, quiz.options, {
                        type: 'quiz',
                        correct_option_id: quiz.correct_option_id,
                        is_anonymous: false,
                        open_period: seconds 
                    });

                    if (i < activeQuizzes.length - 1) {
                        await new Promise(r => setTimeout(r, waitBetweenPolls));
                    }
                }
                
                bot.sendMessage(chatId, "✅ Barcha testlar muvaffaqiyatli yakunlandi va guruhga jo'natildi!", adminKeyboard);
            } catch (err) {
                bot.sendMessage(chatId, "❌ Xato yuz berdi: " + err.message, adminKeyboard);
            }
            return;
        }
    }

    // Natijalarni tahlil qilish (Xatolik tuzatilgan qism — parse_mode butunlay olib tashlandi)
    if (text === "📊 Natijalarni tahlil qilish") {
        try {
            const res = await pool.query('SELECT * FROM results ORDER BY correct_count DESC');
            if (res.rows.length === 0) return bot.sendMessage(chatId, "📭 Natijalar yo'q.");
            
            let report = "📋 Foydalanuvchilar natijalari:\n\n";
            res.rows.forEach((user, i) => {
                report += (i + 1) + ". " + user.name + " — Ball: " + (user.correct_count * 10) + "\n";
            });
            bot.sendMessage(chatId, report); // parse_mode yo'q, xavfsiz oddiy matn
        } catch (err) {
            bot.sendMessage(chatId, "❌ Natijalarni yuklashda xatolik yuz berdi.");
        }
    }
    else if (text === "🧹 Ma'lumotlarni tozalash") {
        await pool.query('TRUNCATE TABLE results');
        activeQuizzes = [];
        currentExcelName = "";
        bot.sendMessage(chatId, "🗑 Hamma ma'lumotlar tozalandi.");
    }
    
    else if (text === "📢 Testni guruh/kanalga yuborish") {
        if (activeQuizzes.length === 0) return bot.sendMessage(chatId, "⚠️ Avval Excel yuklang!");
        
        bot.sendMessage(chatId, `⏱ Har bir savol necha soniya tursin? (Kamida 10 soniya).\n\nMasalan: 15, 30 yoki 45 deb faqat raqam o'zini yuboring:`, { reply_markup: { remove_keyboard: true } });
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
    // Adminlar ro'yxati (Xatolik tuzatilgan qism — parse_mode olib tashlandi)
else if (text === "👥 Adminlar Ro'yxati") {
try {
const res = await pool.query('SELECT * FROM admins');
let txt = "👥 Adminlar ro'yxati:\n\n1. ID: " + SUPER_ADMIN_ID + " (Bosh Admin)\n";
res.rows.forEach((row, i) => {
txt += (i + 2) + ". ID: " + row.telegram_id + " (Admin)\n";
});
bot.sendMessage(chatId, txt); // parse_mode yo'q, xavfsiz oddiy matn
} catch (err) {
bot.sendMessage(chatId, "❌ Adminlar ro'yxatini yuklashda xatolik.");
}
}
});
// Javoblar hisoblagichi
bot.on('poll_answer', async (answer) => {
const userId = answer.user.id;
const fullName = (answer.user.first_name || "") + (answer.user.username ? " (@" + answer.user.username + ")" : "");
try {
await pool.query('INSERT INTO results (id, name, correct_count) VALUES ($1, $2, 1) ON CONFLICT (id) DO UPDATE SET name = $2, correct_count = results.correct_count + 1', [userId, fullName]);
} catch (err) { console.error(err); }
});