import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot';
}

const ChatRoom: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', text: `Welcome to the ${roomId} chat room!`, sender: 'bot' },
    { id: '2', text: `This is a demo chat interface for ${roomId}.`, sender: 'user' },
  ]);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = () => {
    if (inputValue.trim()) {
      const newMessage: Message = {
        id: Date.now().toString(),
        text: inputValue,
        sender: 'user',
      };
      setMessages((prev) => [...prev, newMessage]);
      setInputValue('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow-sm p-4 flex justify-between items-center">
        <Link to="/" className="text-blue-600 hover:text-blue-800 font-medium flex items-center">
          <span className="mr-2">←</span> Back to Rooms
        </Link>
        <h1 className="text-xl font-bold text-gray-800 capitalize">Room: {roomId}</h1>
        <div className="w-24"></div> {/* Spacer */}
      </header>

      <main className="flex-grow p-4 flex flex-col items-center justify-center">
        <div className="bg-white w-full max-w-4xl h-[600px] rounded-xl shadow-inner border border-gray-200 flex flex-col">
          <div className="flex-grow p-6 overflow-y-auto">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`${
                  msg.sender === 'bot'
                    ? 'bg-blue-100 text-blue-900 self-start'
                    : 'bg-gray-100 text-gray-800 self-end ml-auto'
                } p-4 rounded-lg max-w-[80%] mb-4`}
              >
                <p>{msg.text}</p>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-4 border-t border-gray-200">
            <div className="flex gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="Type your message..."
                className="flex-grow p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleSendMessage}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-blue-700"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ChatRoom;
