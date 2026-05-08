const express = require('express');
const router = express.Router();
const AIConversation = require('../models/AIConversation');
const User = require('../models/User');
const { OpenAI } = require('openai');
const auth = require('../middleware/auth');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Grade-level response templates
const gradeTemplates = {
  'grade-1-3': {
    complexity: 'simple',
    vocabulary: 'basic',
    emojiLevel: 'high',
    exampleCount: 1,
    maxLength: 100,
  },
  'grade-4-6': {
    complexity: 'intermediate',
    vocabulary: 'moderate',
    emojiLevel: 'medium',
    exampleCount: 2,
    maxLength: 250,
  },
  'grade-7-9': {
    complexity: 'advanced',
    vocabulary: 'academic',
    emojiLevel: 'low',
    exampleCount: 2,
    maxLength: 400,
  },
  'grade-10-plus': {
    complexity: 'expert',
    vocabulary: 'technical',
    emojiLevel: 'minimal',
    exampleCount: 3,
    maxLength: 500,
  },
};

// Check daily question limit (100 per day)
const checkDailyLimit = async (userId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const questionCount = await AIConversation.countDocuments({
    userId,
    createdAt: { $gte: today },
  });

  return questionCount < 100; // Max 100 questions per day
};

// Get question count for today
const getTodayQuestionCount = async (userId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return await AIConversation.countDocuments({
    userId,
    createdAt: { $gte: today },
  });
};

// Categorize question type
const categorizeQuestion = (question) => {
  const mathKeywords = ['math', 'calculate', 'equation', 'solve', 'add', 'subtract', 'multiply', 'divide', 'percent', 'fraction', 'algebra'];
  const scienceKeywords = ['science', 'biology', 'physics', 'chemistry', 'atom', 'cell', 'photosynthesis', 'gravity', 'energy'];
  const historyKeywords = ['history', 'war', 'civilization', 'ancient', 'medieval', 'revolution', 'century', 'kingdom'];
  const languageKeywords = ['grammar', 'spelling', 'vocabulary', 'english', 'literature', 'writing', 'punctuation'];

  const lowerQuestion = question.toLowerCase();

  if (mathKeywords.some(keyword => lowerQuestion.includes(keyword))) return 'math';
  if (scienceKeywords.some(keyword => lowerQuestion.includes(keyword))) return 'science';
  if (historyKeywords.some(keyword => lowerQuestion.includes(keyword))) return 'history';
  if (languageKeywords.some(keyword => lowerQuestion.includes(keyword))) return 'language';
  return 'general';
};

// Generate grade-appropriate prompt
const generateSystemPrompt = (gradeLevel, category) => {
  const template = gradeTemplates[gradeLevel];
  
  let basePrompt = `You are a friendly, encouraging AI tutor for a child in ${gradeLevel.replace('-', ' ')}. 
Your goal is to help them UNDERSTAND concepts, not just give answers.

Response Guidelines:
- Use ${template.vocabulary} vocabulary appropriate for this grade
- Keep answers under ${template.maxLength} characters
- Include ${template.exampleCount} real-world example(s)
- Add ${template.emojiLevel} level of emojis to make it fun
- Encourage thinking by asking "Do you understand so far?" or "Want to try an example?"
- Never give direct homework answers - guide them to think it through
- Use analogies and simple comparisons
- Complexity level: ${template.complexity}

For ${category} questions:
- Break down into simple steps
- Use diagrams or drawing suggestions if needed
- Connect to real-life applications
- Always encourage questions

Remember: You're tutoring a CHILD, be patient, encouraging, and fun! 🎓`;

  return basePrompt;
};

// Ask AI Robot endpoint
router.post('/ask', auth, async (req, res) => {
  try {
    const { question } = req.body;
    const userId = req.user.id;

    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: 'Question cannot be empty' });
    }

    // Check daily limit (MAX 100 questions per day)
    const canAsk = await checkDailyLimit(userId);
    if (!canAsk) {
      const todayCount = await getTodayQuestionCount(userId);
      return res.status(429).json({
        error: 'Daily question limit reached! (100 per day)',
        questionsAsked: todayCount,
        maxQuestions: 100,
        message: 'Come back tomorrow to ask more questions! 😊',
      });
    }

    // Get user details
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Categorize question
    const category = categorizeQuestion(question);

    // Generate appropriate system prompt
    const systemPrompt = generateSystemPrompt(user.gradeLevel || 'grade-4-6', category);

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: question,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    const answer = completion.choices[0].message.content;

    // Save conversation to database
    const conversation = new AIConversation({
      userId,
      question,
      answer,
      category,
      gradeLevel: user.gradeLevel,
      rating: 0,
    });

    await conversation.save();

    // Get updated question count
    const todayCount = await getTodayQuestionCount(userId);

    res.json({
      conversationId: conversation._id,
      question,
      answer,
      category,
      rating: 0,
      questionsAskedToday: todayCount,
      maxQuestionsPerDay: 100,
      remainingQuestions: 100 - todayCount,
      timestamp: conversation.createdAt,
    });
  } catch (error) {
    console.error('AI Robot error:', error);
    res.status(500).json({ error: 'Failed to get response from AI Robot' });
  }
});

// Get conversation history
router.get('/history/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const conversations = await AIConversation.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await getTodayQuestionCount(userId);

    res.json({
      conversations,
      todayQuestions: todayCount,
      maxQuestionsPerDay: 100,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Rate an answer
router.put('/rate/:conversationId', auth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { rating, helpful } = req.body;

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const conversation = await AIConversation.findByIdAndUpdate(
      conversationId,
      { rating, helpful },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ error: 'Failed to rate answer' });
  }
});

// Update grade level for better responses
router.put('/grade/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { gradeLevel } = req.body;

    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const validGrades = ['grade-1-3', 'grade-4-6', 'grade-7-9', 'grade-10-plus'];
    if (!validGrades.includes(gradeLevel)) {
      return res.status(400).json({ error: 'Invalid grade level' });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { gradeLevel },
      { new: true }
    );

    res.json({ message: 'Grade level updated', gradeLevel: user.gradeLevel });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update grade level' });
  }
});

// Clear conversation history
router.delete('/history/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await AIConversation.deleteMany({ userId });
    res.json({ message: 'Conversation history cleared' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

module.exports = router;
