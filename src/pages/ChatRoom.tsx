import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

const ChatRoom: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      text: `Welcome to the ${roomId} chat room! How can I help you today?`,
      sender: 'ai',
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputValue,
      sender: 'user',
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');

    // Simulate AI response
    setTimeout(() => {
      const aiResponse: Message = {
        id: (Date.now() + 1).toString(),
        text: `I received your message: "${inputValue}". This is a simulated response for the ${roomId} room using Material 3 design principles.`,
        sender: 'ai',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, aiResponse]);
    }, 1000);
  };

  const getThemeColors = () => {
    switch (roomId) {
      case 'openclaw':
        return {
          primary: 'bg-emerald-700',
          container: 'bg-emerald-50',
          onContainer: 'text-emerald-900',
          bubble: 'bg-emerald-100',
          text: 'text-emerald-950',
          button: 'bg-emerald-700 hover:bg-emerald-800',
          header: 'bg-emerald-50 text-emerald-900'
        };
      case 'hermes':
        return {
          primary: 'bg-violet-700',
          container: 'bg-violet-50',
          onContainer: 'text-violet-900',
          bubble: 'bg-violet-100',
          text: 'text-violet-950',
          button: 'bg-violet-700 hover:bg-violet-800',
          header: 'bg-violet-50 text-violet-900'
        };
      default:
        return {
          primary: 'bg-blue-700',
          container: 'bg-blue-50',
          onContainer: 'text-blue-900',
          bubble: 'bg-blue-100',
          text: 'text-blue-950',
          button: 'bg-blue-700 hover:bg-blue-800',
          header: 'bg-blue-50 text-blue-900'
        };
    }
  };

  const theme = getThemeColors();

  return (
    <div className={`min-h-screen ${theme.container} flex flex-col font-sans`}>
      {/* M3 Tonal App Bar */}
      <header className={`${theme.header} px-4 py-3 flex items-center sticky top-0 z-10 shadow-sm transition-colors duration-300`}>
        <Link to="/" className={`p-2 rounded-full hover:bg-black/5 transition-colors mr-2`}>
          <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </Link>
        <h1 className="text-xl font-semibold capitalize tracking-tight">{roomId}</h1>
        <div className="flex-grow"></div>
        <button className="p-2 rounded-full hover:bg-black/5">
          <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current">
            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
          </svg>
        </button>
      </header>

      <main className="flex-grow flex flex-col p-4 max-w-5xl mx-auto w-full overflow-hidden">
        {/* Messages Container with M3 rounded corners */}
        <div className="flex-grow overflow-y-auto space-y-2 mb-4 px-2 custom-scrollbar">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex w-full ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
            >
              <div className={`flex flex-col max-w-[85%] sm:max-w-[70%]`}>
                <div
                  className={`px-4 py-3 shadow-sm ${
                    msg.sender === 'user'
                      ? `${theme.primary} text-white rounded-[20px] rounded-tr-[4px]`
                      : `${theme.bubble} ${theme.text} rounded-[20px] rounded-tl-[4px]`
                  }`}
                >
                  <p className="leading-relaxed text-[15px]">{msg.text}</p>
                </div>
                <div className={`mt-1 flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <span className="text-[11px] font-medium opacity-60 px-1">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area - M3 style */}
        <div className="pt-2 px-2">
          <form onSubmit={handleSendMessage} className="flex items-center gap-3 bg-white/60 backdrop-blur-md p-2 pl-5 rounded-full border border-black/5 shadow-md">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Message..."
              className="flex-grow bg-transparent border-none focus:outline-none py-2 text-gray-800 placeholder-gray-500"
            />
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className={`${theme.button} text-white w-12 h-12 flex items-center justify-center rounded-full transition-all duration-200 shadow-sm disabled:opacity-50 disabled:grayscale`}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </form>
        </div>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.2);
        }
      `}} />
    </div>
  );
};

export default ChatRoom;
